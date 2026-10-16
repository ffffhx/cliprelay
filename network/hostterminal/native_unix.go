//go:build (darwin || linux) && cgo

package hostterminal

/*
#include <sys/types.h>
#include <sys/wait.h>
#include <errno.h>
#include <string.h>
#include <termios.h>
// Observe without reaping. Until Cmd.Wait, the child PID cannot be reused by
// an unrelated process group during terminal teardown.
static int terminal_child_exited(int pid) {
    siginfo_t info;
    memset(&info, 0, sizeof(info));
    if (waitid(P_PID, (id_t)pid, &info, WEXITED | WNOHANG | WNOWAIT) != 0) return -errno;
    return info.si_pid == pid;
}
static int terminal_canonical_mode(int fd) {
    struct termios settings;
    if (tcgetattr(fd, &settings) != 0) return -errno;
    return (settings.c_lflag & ICANON) != 0;
}
*/
import "C"

import (
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

type queuedInput struct {
	data     []byte
	sequence int64
	paste    bool
}
type nativeProcess struct {
	mu                              sync.Mutex
	state                           ProcessState
	command                         *exec.Cmd
	terminal                        *os.File
	fd                              int
	queue                           chan queuedInput
	queued                          int
	closing                         bool
	stop, done, readDone, writeDone chan struct{}
}

// StartNative never accepts paths, argument strings or environment overrides
// from a network request. The shell runs as the ordinary owning desktop user.
func StartNative(shell string, columns, rows int, output func([]byte)) (Process, error) {
	if !shellAllowed(shell) || !dimensions(columns, rows) {
		return nil, errors.New("TERMINAL_BAD_REQUEST")
	}
	if os.Geteuid() == 0 || os.Geteuid() != os.Getuid() {
		return nil, errors.New("TERMINAL_USER_REQUIRED")
	}
	command := exec.Command("/bin/"+shell, "-l", "-i")
	directory, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	command.Dir = directory
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		if key != "TERM" && key != "COLORTERM" && key != "COLUMNS" && key != "LINES" {
			command.Env = append(command.Env, value)
		}
	}
	command.Env = append(command.Env, "TERM=xterm-256color", "COLORTERM=truecolor")
	terminal, slave, err := pty.Open()
	if err != nil {
		return nil, err
	}
	defer slave.Close()
	// Preserve the ordinary terminal defaults. Readline saves these settings
	// and restores them for foreground programs (including canonical EOF/editing).
	if err = pty.Setsize(terminal, &pty.Winsize{Cols: uint16(columns), Rows: uint16(rows)}); err != nil {
		_ = terminal.Close()
		return nil, err
	}
	command.Stdin = slave
	command.Stdout = slave
	command.Stderr = slave
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err = command.Start(); err != nil {
		_ = terminal.Close()
		return nil, err
	}
	// A fresh nonblocking descriptor lets os.File deadlines and Close interrupt
	// stalled reads/writes. Do not call File.Fd again: it can restore blocking I/O.
	fd, err := unix.Dup(int(terminal.Fd()))
	if err == nil {
		unix.CloseOnExec(fd)
		err = unix.SetNonblock(fd, true)
	}
	if err != nil {
		if fd >= 0 {
			_ = unix.Close(fd)
		}
		_ = terminal.Close()
		_ = command.Process.Kill()
		_ = command.Wait()
		return nil, err
	}
	pollable := os.NewFile(uintptr(fd), "cliprelay-terminal")
	_ = terminal.Close()
	if err = pollable.SetWriteDeadline(time.Now().Add(3 * time.Second)); err != nil {
		_ = pollable.Close()
		_ = command.Process.Kill()
		_ = command.Wait()
		return nil, err
	}
	p := &nativeProcess{command: command, terminal: pollable, fd: fd, queue: make(chan queuedInput, 8), stop: make(chan struct{}), done: make(chan struct{}), readDone: make(chan struct{}), writeDone: make(chan struct{})}
	go p.read(output)
	go p.write()
	go p.monitor()
	return p, nil
}
func (p *nativeProcess) fail() { p.mu.Lock(); p.state.Failed = true; p.mu.Unlock(); p.Close() }
func (p *nativeProcess) read(output func([]byte)) {
	defer close(p.readDone)
	buffer := make([]byte, ReadLimit)
	for {
		n, err := p.terminal.Read(buffer)
		if n > 0 {
			output(buffer[:n])
		}
		if err != nil {
			return
		}
	}
}

// A large unbroken line must not enter the initial canonical input buffer:
// kernels can discard excess bytes while still reporting successful writes.
// Short lines, control keys and ordinary multiline input remain usable by
// canonical foreground programs and startup scripts that prompt for input.
func needsLineEditor(data []byte) bool {
	line := 0
	for _, b := range data {
		if b == '\r' || b == '\n' {
			line = 0
		} else {
			line++
			if line >= 1024 {
				return true
			}
		}
	}
	return false
}

func (p *nativeProcess) waitLineEditor() bool {
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		p.mu.Lock()
		if p.closing {
			p.mu.Unlock()
			return false
		}
		// Close uses the same lock; the numeric descriptor cannot be reused
		// underneath tcgetattr. Observation never changes the program's mode.
		mode := int(C.terminal_canonical_mode(C.int(p.fd)))
		p.mu.Unlock()
		if mode <= 0 {
			return mode == 0
		}
		select {
		case <-p.stop:
			return false
		case <-deadline.C:
			return false
		case <-ticker.C:
		}
	}
}

func (p *nativeProcess) write() {
	defer close(p.writeDone)
	for {
		select {
		case <-p.stop:
			return
		case item := <-p.queue:
			p.mu.Lock()
			closing := p.closing
			p.mu.Unlock()
			if closing {
				return
			}
			budget := 3 * time.Second
			if item.paste {
				budget = 15 * time.Second
			}
			deadline := time.Now().Add(budget)
			if needsLineEditor(item.data) && !p.waitLineEditor() {
				p.fail()
				return
			}
			offset := 0
			for offset < len(item.data) {
				// A line editor can redraw while consuming a large unbracketed
				// paste. Bound both total time and each blocked chunk, preserving
				// one ordered item and acknowledging only the complete payload.
				step := min(len(item.data)-offset, 512)
				idleDeadline := time.Now().Add(3 * time.Second)
				if deadline.Before(idleDeadline) {
					idleDeadline = deadline
				}
				if p.terminal.SetWriteDeadline(idleDeadline) != nil {
					p.fail()
					return
				}
				n, err := p.terminal.Write(item.data[offset : offset+step])
				offset += n
				if err != nil || n == 0 {
					p.fail()
					return
				}
			}
			p.mu.Lock()
			p.state.Written = item.sequence
			p.queued -= len(item.data)
			p.mu.Unlock()
		}
	}
}
func (p *nativeProcess) Queue(data []byte, sequence int64, paste bool) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closing || p.state.Exited || p.state.Failed || p.queued+len(data) > 32768 {
		return false
	}
	select {
	case p.queue <- queuedInput{data: append([]byte(nil), data...), sequence: sequence, paste: paste}:
		p.queued += len(data)
		return true
	default:
		return false
	}
}
func (p *nativeProcess) Resize(columns, rows int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closing {
		return errors.New("TERMINAL_CLOSED")
	}
	return unix.IoctlSetWinsize(p.fd, unix.TIOCSWINSZ, &unix.Winsize{Col: uint16(columns), Row: uint16(rows)})
}
func (p *nativeProcess) Status() ProcessState { p.mu.Lock(); defer p.mu.Unlock(); return p.state }
func (p *nativeProcess) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.closing {
		p.closing = true
		close(p.stop)
	}
}
func (p *nativeProcess) Done() <-chan struct{} { return p.done }
func (p *nativeProcess) monitor() {
	defer close(p.done)
	ticker := time.NewTicker(30 * time.Millisecond)
	defer ticker.Stop()
	observed := false
	owned := true
wait:
	for {
		select {
		case <-p.stop:
			break wait
		case <-ticker.C:
			status := int(C.terminal_child_exited(C.int(p.command.Process.Pid)))
			if status == 1 {
				observed = true
				break wait
			}
			if status < 0 && status != -int(unix.EINTR) {
				if status == -int(unix.ECHILD) {
					owned = false
				}
				p.mu.Lock()
				p.state.Failed = true
				p.mu.Unlock()
				break wait
			}
		}
	}
	p.Close()
	if owned {
		// The unreaped session leader pins this process-group ID. Never signal
		// arbitrary PIDs found by a process-name scan or after reaping the child.
		_ = unix.Kill(-p.command.Process.Pid, unix.SIGHUP)
	}
	// Give the login shell time to propagate hangup to its normal jobs and the
	// reader time to retain final output. Explicitly detached daemons are not
	// a process group owned by this PTY and are not claimed as contained jobs.
	if observed {
		select {
		case <-p.readDone:
		case <-time.After(100 * time.Millisecond):
		}
	} else {
		time.Sleep(150 * time.Millisecond)
	}
	p.mu.Lock()
	_ = p.terminal.Close()
	p.mu.Unlock()
	if owned {
		_ = unix.Kill(-p.command.Process.Pid, unix.SIGKILL)
	}
	err := p.command.Wait()
	<-p.readDone
	<-p.writeDone
	p.mu.Lock()
	defer p.mu.Unlock()
	p.state.Exited = true
	p.state.ExitCode = -1
	if p.command.ProcessState != nil {
		p.state.ExitCode = p.command.ProcessState.ExitCode()
	}
	if err != nil && p.command.ProcessState == nil {
		p.state.Failed = true
	}
}

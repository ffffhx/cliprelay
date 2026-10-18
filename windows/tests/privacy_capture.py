"""Bounded production-mask test against one owned marker pixel; no screenshots."""
import ctypes, json, pathlib, subprocess, sys, time

def main():
    root=pathlib.Path(__file__).resolve().parents[2]
    fixture=root/'.tools/uu-parity/privacy-screen-tests.exe'
    capture=root/'.tools/uu-parity/privacy-capture.exe'
    process=subprocess.Popen([str(fixture),'--capture-fixture'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
    result={"method":"DXGI Desktop Duplication; one pixel within synthetic owned window","samples":{}}
    try:
        state=json.loads(process.stdout.readline())
        if state['pid']!=process.pid:raise RuntimeError('fixture PID mismatch')
        for command in ('hide','plain','excluded','hide'):
            process.stdin.write(command+'\n');process.stdin.flush()
            if process.stdout.readline().strip()!='ready':raise RuntimeError('fixture did not acknowledge')
            time.sleep(.2)
            sample=json.loads(subprocess.check_output([str(capture),str(process.pid),str(state['hwnd'])],text=True,timeout=6,creationflags=subprocess.CREATE_NO_WINDOW))
            name=command if command!='hide' or 'hide' not in result['samples'] else 'restored'
            result['samples'][name]=sample
        samples=result['samples']
        # Composition can transform color intensity (e.g. an HDR desktop). The
        # unmasked marker is the reference; exclusion must preserve that pixel.
        red=lambda p:p['r']>=64 and p['g']<=16 and p['b']<=16
        same=lambda a,b:all(abs(a[k]-b[k])<=2 for k in ('r','g','b'))
        black=lambda p:max(p['r'],p['g'],p['b'])<=8
        result['passed']=red(samples['hide']) and black(samples['plain']) and same(samples['hide'],samples['excluded']) and same(samples['hide'],samples['restored'])
    finally:
        if process.poll() is None:
            try:process.stdin.close();process.wait(timeout=4)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=4)
        result['fixtureExited']=process.poll() is not None
        result['fixtureDiagnostics']=process.stderr.read()
        user=ctypes.WinDLL('user32');user.IsWindow.argtypes=[ctypes.c_void_p];user.IsWindow.restype=ctypes.c_bool
        result['maskRemoved']=not user.IsWindow(state['mask']) if 'state' in locals() else False
        if result.get('passed'):
            crash=subprocess.Popen([str(fixture),'--capture-fixture'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                crash_state=json.loads(crash.stdout.readline())
                if crash_state['pid']!=crash.pid:raise RuntimeError('crash fixture PID mismatch')
                crash.stdin.write('excluded\n');crash.stdin.flush()
                if crash.stdout.readline().strip()!='ready':raise RuntimeError('crash fixture not ready')
                crash.kill();crash.wait(timeout=4)
                result['crashRemovesMask']=not user.IsWindow(crash_state['mask'])
            finally:
                if crash.poll() is None:crash.kill();crash.wait(timeout=4)
        output=root/'.tools/uu-parity/privacy-capture-report.json'
        output.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
        print(json.dumps(result))
    return 0 if result.get('passed') and result['maskRemoved'] and result.get('crashRemovesMask') else 1

if __name__=='__main__':sys.exit(main())

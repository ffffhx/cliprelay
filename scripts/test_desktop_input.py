"""Compile and run the production native input queue against a memory transport."""
import argparse
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
parser.add_argument('--compiler', default='clang' if sys.platform == 'win32' else 'cc')
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
common = args.source.resolve(strict=True) / 'moonlight-common-c/moonlight-common-c'
assert common.joinpath('src/InputStream.c').is_file()
args.output.parent.mkdir(parents=True, exist_ok=True)
command = [args.compiler, '-std=c11', '-O1', '-DLC_DEBUG', '-Wall', '-Wextra', '-Wno-unused-parameter',
           '-I'+str(common/'src'), '-I'+str(common/'enet/include'),
           str(root/'engine/desktop-client/tests/input_epoch.c'),
           *(str(common/'src'/name) for name in ['Platform.c','PlatformSockets.c','LinkedBlockingQueue.c'])]
if sys.platform == 'win32':
    command += ['-DHAS_SOCKLEN_T','-DHAS_QOS_FLOWID','-DHAS_PQOS_FLOWID','-D_WIN32_WINNT=0x0601','-lws2_32','-lwinmm']
else:
    # Strict C11 hides POSIX socket declarations unless explicitly requested.
    command += ['-D_POSIX_C_SOURCE=200809L','-D_DEFAULT_SOURCE','-pthread','-lm']
subprocess.run(command+['-o',str(args.output)], check=True, timeout=120)
subprocess.run([str(args.output.resolve(strict=True))], check=True, timeout=15)

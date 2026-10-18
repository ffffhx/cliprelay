"""Run the production UTF-8 Java/JNI boundary against an isolated recording queue.

Windows host fixture only. It compiles verbatim production method/function bodies,
loads them in a real JVM, and never links Moonlight or emits desktop input.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.tools/uu-parity/text-jni'
parser = argparse.ArgumentParser()
parser.add_argument('--java-home', default=os.environ.get('JAVA_HOME', 'D:/jdk17'))
args = parser.parse_args()
java_home = Path(args.java_home)
compiler = shutil.which('clang')
assert compiler and (java_home/'include/win32/jni_md.h').exists(), 'Windows clang and JDK required'
bridge_path = ROOT/'android-app/remote-engine/src/main/java/com/limelight/nvstream/jni/MoonBridge.java'
native_path = ROOT/'android-app/remote-engine/src/main/jni/moonlight-core/simplejni.c'
bridge = bridge_path.read_text(encoding='utf-8')
begin = bridge.index('    public static void sendUtf8Text(String text)')
end = bridge.index('    private static native int sendUtf8TextBytes(byte[] text);', begin)
java_methods = bridge[begin:end+len('    private static native int sendUtf8TextBytes(byte[] text);')]
native = native_path.read_text(encoding='utf-8')
begin = native.index('JNIEXPORT jint JNICALL\nJava_com_limelight_nvstream_jni_MoonBridge_sendUtf8TextBytes(')
opening = native.index('{', begin)
depth = 1
end = opening + 1
while depth:
    if native[end] == '{': depth += 1
    elif native[end] == '}': depth -= 1
    end += 1
native_function = native[begin:end]
OUT.mkdir(parents=True, exist_ok=True)
c_source = r'''
#include <jni.h>
#include <string.h>
static unsigned char captured[65536];
static int captured_length, calls, next_result;
static int LiSendUtf8TextEvent(const char* bytes, unsigned int length) {
    if (length > sizeof(captured)) return -99;
    memcpy(captured, bytes, length); captured_length = (int)length; calls++;
    return next_result;
}
''' + native_function + r'''
JNIEXPORT void JNICALL Java_com_limelight_nvstream_jni_MoonBridge_configure(JNIEnv* env, jclass cls, jint value) { next_result = value; }
JNIEXPORT jint JNICALL Java_com_limelight_nvstream_jni_MoonBridge_calls(JNIEnv* env, jclass cls) { return calls; }
JNIEXPORT jbyteArray JNICALL Java_com_limelight_nvstream_jni_MoonBridge_captured(JNIEnv* env, jclass cls) {
    jbyteArray result = (*env)->NewByteArray(env, captured_length);
    (*env)->SetByteArrayRegion(env, result, 0, captured_length, (jbyte*)captured);
    return result;
}
'''
java_source = '''package com.limelight.nvstream.jni;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
public class MoonBridge {
''' + java_methods + r'''
    private static native void configure(int value);
    private static native int calls();
    private static native byte[] captured();
    private static void require(boolean value) { if (!value) throw new AssertionError("JNI text fixture failed"); }
    public static void main(String[] args) {
        System.load(args[0]);
        String[] values={"ASCII", "\u4e2d\u6587", "\ud83d\ude42\ud801\udc37", "a\u0000b", "e\u0301\u4e2d\ud83d\ude42".repeat(1000)};
        for (String value:values) {
            configure(0); require(sendUtf8TextChecked(value)==0);
            require(Arrays.equals(value.getBytes(StandardCharsets.UTF_8),captured()));
        }
        for (int result:new int[]{-2,-1,1,0}) {configure(result);require(sendUtf8TextChecked("queue status")==result);}
        int before=calls();require(sendUtf8TextChecked("")==0);require(calls()==before);
        sendUtf8Text("legacy \ud83d\ude42");require(Arrays.equals("legacy \ud83d\ude42".getBytes(StandardCharsets.UTF_8),captured()));
        System.out.println("PASS standard UTF-8, non-BMP, embedded NUL, long text, exact queue results, empty input, legacy wrapper");
    }
}
'''
# Java escapes in the fixture are source literals, not Python-decoded surrogates.
java_source = java_source.replace('\\\\u', '\\u')
(OUT/'bridge.c').write_text(c_source, encoding='utf-8')
(OUT/'MoonBridge.java').write_text(java_source, encoding='utf-8')
dll = OUT/'cliprelay-text-jni.dll'
def run(command):
    result = subprocess.run(command,capture_output=True,text=True,timeout=30)
    if result.returncode:
        raise RuntimeError(result.stdout+'\n'+result.stderr)
    return result.stdout
run([compiler,'-shared','-O2','-std=c11','-I'+str(java_home/'include'),'-I'+str(java_home/'include/win32'),str(OUT/'bridge.c'),'-o',str(dll)])
run([str(java_home/'bin/javac.exe'),'-encoding','UTF-8','-d',str(OUT),str(OUT/'MoonBridge.java')])
result=run([str(java_home/'bin/java.exe'),'-cp',str(OUT),'com.limelight.nvstream.jni.MoonBridge',str(dll)])
assert result.startswith('PASS '), result
report={'status':'passed','checks':7,'output':result.strip(),
        'scope':'Real Windows JVM/JNI with verbatim production Java methods and C function; recording queue fixture, no Moonlight connection or Android device',
        'source_sha256':{str(path.relative_to(ROOT)).replace('\\','/'):hashlib.sha256(path.read_bytes()).hexdigest().upper() for path in (bridge_path,native_path)},
        'native_function_sha256':hashlib.sha256(native_function.encode()).hexdigest(),
        'java_methods_sha256':hashlib.sha256(java_methods.encode()).hexdigest()}
(ROOT/'.tools/uu-parity/text-jni-report.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))

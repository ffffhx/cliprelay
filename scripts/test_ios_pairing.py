"""Exercise the production iOS pairing implementation against synthetic host challenges on macOS."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import plistlib
import subprocess
import tempfile
import uuid

from prepare_ios_client import ROOT, prepare


def test(source, output):
    if platform.system() != 'Darwin':
        raise RuntimeError('Native pairing tests require macOS')
    prepare(source)
    native = source/'Limelight/Network'; crypto = source/'Limelight/Crypto'
    utility = source/'Limelight/Utility'
    with tempfile.TemporaryDirectory(prefix='cliprelay-ios-pairing-') as temporary:
        directory = Path(temporary)
        bundle = directory/'PairingProbe.app'; contents = bundle/'Contents'
        (contents/'MacOS').mkdir(parents=True)
        identifier = 'com.cliprelay.test.pairing.'+uuid.uuid4().hex
        (contents/'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':identifier, 'CFBundleExecutable':'PairingProbe', 'CFBundlePackageType':'APPL'}))
        executable = contents/'MacOS/PairingProbe'
        # Only UIKit presentation and unused generated CoreData entity declarations
        # are absent. Every pairing, HTTP, TLS, crypto and utility implementation is
        # compiled directly from the same prepared source as the iOS application.
        prefix = directory/'prefix.h'
        prefix.write_text('#import <Foundation/Foundation.h>\n#import <CFNetwork/CFNetwork.h>\n#import <TargetConditionals.h>\n#undef TARGET_OS_TV\n#define TARGET_OS_TV 1\n@class UIAlertController;\n#define Log(...) ((void)0)\n')
        for entity in ('Host','App'):
            (directory/(entity+'+CoreDataClass.h')).write_text('@class '+entity+';\n')
        openssl_root = Path(subprocess.check_output(['brew','--prefix','openssl@3'], text=True).strip())
        openssl = openssl_root/'bin/openssl'
        (directory/'OpenSSL').symlink_to(openssl_root/'include/openssl')
        common = source/'moonlight-common/moonlight-common-c/src'
        sdk = Path(subprocess.check_output(['xcrun','--show-sdk-path'],text=True).strip())
        sources = [ROOT/'ios-app/tests/pairing.m', native/'PairManager.m', native/'HttpManager.m',
                   native/'CRTransport.m', native/'CRPairingTicket.m', native/'HttpRequest.m', native/'HttpResponse.m',
                   crypto/'CryptoManager.m', utility/'Utils.m']
        includes = [directory,native,crypto,utility,source/'Limelight/Stream',source/'Limelight/Database',common,
                    openssl_root/'include',sdk/'usr/include/libxml2']
        compiler = ['xcrun','clang','-fobjc-arc','-fmodules','-Wno-deprecated-declarations','-include',str(prefix)]
        for item in includes: compiler += ['-I',str(item)]
        subprocess.run(['xcrun','clang','-c',str(crypto/'mkcert.c'),'-I',str(directory),'-I',str(openssl_root/'include'),
                        '-Wno-deprecated-declarations','-o',str(directory/'mkcert.o')],check=True)
        subprocess.run(compiler+[str(p) for p in sources]+[str(directory/'mkcert.o'),'-framework','Foundation','-framework','Security',
                       '-framework','CFNetwork','-L',str(openssl_root/'lib'),'-lcrypto','-lxml2','-o',str(executable)],check=True)
        def command(*args):
            return subprocess.check_output(args,cwd=directory,stderr=subprocess.STDOUT)
        command(str(openssl),'req','-x509','-newkey','rsa:2048','-nodes','-keyout','server.key','-out','server.crt','-subj','/CN=ClipRelay pairing fixture','-days','1')
        command(str(openssl),'x509','-in','server.crt','-outform','DER','-out','server.der')
        subprocess.run([str(executable),'identity',str(directory)],check=True,timeout=15)
        results=[]
        try:
            for mode in ('good','bad-code','short-challenge','bad-signature','reject','expire','cancel'):
                peer=subprocess.Popen(['node',str(ROOT/'ios-app/tests/pairing-fixture.cjs'),str(directory),mode],
                                      stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                try:
                    port=json.loads(peer.stdout.readline())['port']
                    result=json.loads(subprocess.check_output([str(executable),mode,str(directory),'127.0.0.1:'+str(port)],timeout=30))
                    _,errors=peer.communicate('done\n',timeout=10)
                    if peer.returncode: raise RuntimeError(errors)
                    state=json.loads((directory/('peer-'+mode+'.json')).read_bytes())
                    assert result['passed'] and (mode=='bad-code' or state['deleted'])
                    assert mode!='good' or state['proofFinished']
                    assert mode not in ('bad-code','short-challenge','bad-signature','reject','expire','cancel') or not state['proofFinished']
                    results.append({'mode':mode,**result,**state})
                finally:
                    if peer.poll() is None:
                        peer.terminate();peer.wait(timeout=10)
        finally:
            subprocess.run([str(executable),'cleanup',str(directory)],check=True,timeout=15)
        report={'passed':True,'cases':results,'physicalDeviceAccepted':False,'streamingAccepted':False,
                'sourceHashes':{p.relative_to(source).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sources[1:]}}
        output.parent.mkdir(parents=True,exist_ok=True)
        output.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
        print(json.dumps(report))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--output',type=Path,default=ROOT/'.tools/ios-pairing/report.json')
    args=parser.parse_args();test(args.source.resolve(),args.output)

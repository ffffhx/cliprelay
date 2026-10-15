"""Build pinned macOS runtime dependencies for the host's deployment target."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import urllib.request


def build(directory):
    if platform.system() != 'Darwin' or platform.machine() not in ('arm64', 'x86_64'):
        raise RuntimeError('Native macOS runner required')
    root = Path(__file__).resolve().parents[1]
    pin_file = root / 'engine/sunshine/macos-dependencies.json'
    pins = json.loads(pin_file.read_text())
    target, arch = pins['deploymentTarget'], platform.machine()
    directory = directory.resolve()
    prefix = directory / 'install'
    receipt = prefix / 'build.json'
    identity = {'arch':arch, 'deploymentTarget':target,
                'pinsSha256':hashlib.sha256(pin_file.read_bytes()).hexdigest(),
                'builderSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    if receipt.exists():
        cached = json.loads(receipt.read_text())
        assert cached['identity'] == identity, 'Cached dependency build inputs changed'
        for name, digest in cached['files'].items():
            assert hashlib.sha256((prefix/name).read_bytes()).hexdigest() == digest, name
        print('Verified cached macOS dependency build', flush=True)
        return
    directory.mkdir(parents=True, exist_ok=True)
    prefix.mkdir(exist_ok=True)
    sdk = subprocess.check_output(['xcrun','--sdk','macosx','--show-sdk-path'],text=True).strip()
    flags = f'-O2 -isysroot {sdk} -mmacosx-version-min={target}'
    env = dict(os.environ, MACOSX_DEPLOYMENT_TARGET=target,
               CC='clang', CXX='clang++', CFLAGS=flags, CXXFLAGS=flags,
               LDFLAGS=f'-isysroot {sdk} -mmacosx-version-min={target}',
               PKG_CONFIG_PATH=str(prefix/'lib/pkgconfig'))
    def run(*args, cwd=directory):
        subprocess.run([str(x) for x in args], cwd=cwd, env=env, check=True)
    def cmake(source, name, *options):
        output = directory / (name+'-build')
        run('cmake','-S',source,'-B',output,'-G','Ninja',
            '-DCMAKE_BUILD_TYPE=Release','-DCMAKE_INSTALL_PREFIX='+str(prefix),
            '-DCMAKE_INSTALL_LIBDIR=lib','-DCMAKE_OSX_DEPLOYMENT_TARGET='+target,
            '-DCMAKE_OSX_ARCHITECTURES='+arch,'-DBUILD_SHARED_LIBS=OFF',*options)
        run('cmake','--build',output,'--parallel','3')
        run('cmake','--install',output)
    for name in ['openssl','opus','miniupnpc','icu','boost']:
        pin = pins['sources'][name]
        archive_path = directory / pin['url'].rsplit('/',1)[1]
        if not archive_path.exists():
            with urllib.request.urlopen(pin['url'],timeout=60) as response, archive_path.open('wb') as out:
                shutil.copyfileobj(response,out)
        assert hashlib.sha256(archive_path.read_bytes()).hexdigest() == pin['sha256'], name
        extraction = directory / (name+'-source')
        extraction.mkdir()
        with tarfile.open(archive_path) as archive:
            archive.extractall(extraction, filter='data')
        children = list(extraction.iterdir())
        assert len(children) == 1 and children[0].is_dir(), name
        source = children[0]
        print('Building '+name+' '+pin['version']+' for macOS '+target, flush=True)
        if name == 'openssl':
            machine = 'darwin64-arm64-cc' if arch == 'arm64' else 'darwin64-x86_64-cc'
            run('perl','Configure',machine,'no-shared','no-tests','no-module',
                '--prefix='+str(prefix),'--libdir=lib','-mmacosx-version-min='+target,cwd=source)
            run('make','-j3','build_libs',cwd=source)
            run('make','install_dev',cwd=source)
        elif name == 'opus':
            cmake(source,name,'-DOPUS_BUILD_SHARED_LIBRARY=OFF','-DOPUS_BUILD_TESTING=OFF')
        elif name == 'miniupnpc':
            cmake(source,name,'-DUPNPC_BUILD_SHARED=OFF','-DUPNPC_BUILD_STATIC=ON',
                  '-DUPNPC_BUILD_TESTS=OFF','-DUPNPC_BUILD_SAMPLE=OFF')
        elif name == 'icu':
            output = directory / 'icu-build'; output.mkdir()
            run(source/'source/configure','--prefix='+str(prefix),'--enable-static','--disable-shared',
                '--disable-tests','--disable-samples','--with-library-bits=64',cwd=output)
            run('make','-j3',cwd=output)
            run('make','install',cwd=output)
        elif name == 'boost':
            cmake(source,name,'-DBUILD_TESTING=OFF','-DBOOST_ENABLE_CMAKE=ON',
                  '-DBOOST_INCLUDE_LIBRARIES=filesystem;log;program_options;system;locale;asio;crc;format;process;property_tree',
                  '-DICU_ROOT='+str(prefix))
        notices = [p for p in source.iterdir() if p.is_file()
                   and p.name.lower().startswith(('license','copying','notice'))]
        assert notices, 'Missing source license: '+name
        destination = prefix / 'licenses' / name; destination.mkdir(parents=True)
        for notice in notices:
            shutil.copyfile(notice,destination/notice.name)
    required = ['libssl.a','libcrypto.a','libopus.a','libminiupnpc.a','libicuuc.a','libicui18n.a','libicudata.a']
    for name in required:
        assert (prefix/'lib'/name).is_file(), 'Missing static runtime library: '+name
    assert list((prefix/'lib/cmake').glob('Boost-1.89.0/BoostConfig.cmake'))
    assert not list((prefix/'lib').glob('*.dylib')), 'Dependencies must be linked statically'
    files = {p.relative_to(prefix).as_posix():hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted(prefix.rglob('*')) if p.is_file()}
    receipt.write_text(json.dumps({'identity':identity,'sources':pins['sources'],'files':files},indent=2)+'\n')
    print('Pinned macOS dependencies built and recorded',flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',type=Path)
    build(parser.parse_args().directory)

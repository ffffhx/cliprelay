"""Verify both native Mac builds before creating immutable public release assets."""
import argparse
import hashlib
import json
import plistlib
import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'https://github.com/ffffhx/cliprelay'


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify(directory, architecture, version, commit, allow_deferred_stream=False):
    receipt = read_json(directory / f'app-bundle-{architecture}.json')
    name = f'ClipRelay-macOS-{architecture}-{version}.zip'
    require(receipt.get('passed') is True and receipt.get('architecture') == architecture
            and receipt.get('version') == version and receipt.get('sourceCommit') == commit,
            'Application receipt does not match the selected source/version/architecture')
    require(receipt.get('signature') == 'ad-hoc' and receipt.get('notarized') is False,
            'This release path describes only ad-hoc signed, unnotarized applications')
    require(receipt.get('viewer') is True and receipt.get('network') is True,
            'Public packages must include the viewer and network helper')
    require(receipt.get('host') == receipt.get('companion'), 'Host components must be selected together')
    archive = directory / name
    with archive.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    require(receipt.get('archive') == name and receipt.get('sha256') == digest
            and receipt.get('size') == archive.stat().st_size, 'Archive checksum/size mismatch')
    reports = ['viewer-bundle', 'network-bundle', 'native-login-startup']
    if receipt['host']:
        reports += ['host-engine-bundle', 'host-companion-bundle', 'host-pairing-bundle',
                    'host-clients-bundle', 'host-background-bundle']
        if receipt.get('streamAcceptance') == 'deferred':
            require(allow_deferred_stream, 'Deferred streaming requires explicit publication authorization')
        else:
            require(receipt.get('streamAcceptance') == 'passed', 'Unknown streaming acceptance state')
            reports += ['native-stream-bundle', 'native-audio-bundle']
    for kind in reports:
        require(read_json(directory / f'{kind}-{architecture}.json').get('passed') is True,
                f'Missing or failed native acceptance: {kind}/{architecture}')
    clipboard = read_json(directory / f'native-clipboard-bundle-{architecture}.json')
    require(clipboard.get('arch') == architecture and clipboard.get('head') == commit
            and clipboard.get('syntheticOnly') is True
            and len(clipboard.get('cases', [])) == (16 if receipt['host'] else 15),
            'Native clipboard acceptance does not match this application')
    prefix = 'ClipRelay.app/Contents/Resources/app/'
    with zipfile.ZipFile(archive) as package:
        require(package.testzip() is None, 'Corrupt ZIP entry')
        info = plistlib.loads(package.read('ClipRelay.app/Contents/Info.plist'))
        require(info['CFBundleIdentifier'] == 'com.cliprelay.desktop'
                and info['CFBundleShortVersionString'] == version
                and info['LSMinimumSystemVersion'] == receipt['minimumOS'], 'Application plist mismatch')
        for source in (ROOT / 'windows/electron/mac').rglob('*'):
            if source.is_file():
                relative = source.relative_to(ROOT / 'windows/electron').as_posix()
                require(package.read(prefix + relative) == source.read_bytes(), f'Packaged source differs: {relative}')
        components = ['network-helper', 'stream-viewer']
        if receipt['host']:
            components += ['host-engine', 'host-companion']
        for component in components:
            base = prefix + 'mac/' + component + '/'
            manifest = json.loads(package.read(base + 'manifest.json'))
            for filename, expected in manifest['files'].items():
                require(hashlib.sha256(package.read(base + filename)).hexdigest() == expected,
                        f'Embedded component checksum mismatch: {component}/{filename}')
    return archive, receipt


def prepare(artifacts, output, commit, run, allow_deferred_stream=False):
    require(re.fullmatch(r'[a-f0-9]{40}', commit) and re.fullmatch(r'[0-9]+', run), 'Invalid build identity')
    version = read_json(ROOT / 'windows/version.json')['versionName']
    require(re.fullmatch(r'\d+\.\d+\.\d+', version), 'Invalid release version')
    verified = [verify(artifacts / f'ClipRelay-macOS-{arch}', arch, version, commit, allow_deferred_stream) for arch in ('arm64', 'x64')]
    require(verified[0][1]['host'] == verified[1][1]['host'], 'Architectures must have the same capabilities')
    output.mkdir(parents=True, exist_ok=False)
    assets = {}
    for archive, receipt in verified:
        shutil.copyfile(archive, output / archive.name)
        assets[receipt['architecture']] = {**receipt,
            'downloadUrl': f'{REPOSITORY}/releases/download/macos-v{version}/{archive.name}'}
    metadata = dict(versionName=version, platform='macos', sourceCommit=commit, buildRun=int(run),
                    notarized=False, signature='ad-hoc', assets=assets)
    (output / 'macos-update.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (output / 'SHA256SUMS').write_text(''.join(f"{r['sha256']}  {r['archive']}\n" for _, r in verified), encoding='utf-8')
    minimum = '；'.join(f"{'Apple Silicon' if arch == 'arm64' else 'Intel'}：macOS {r['minimumOS']}+" for arch, r in assets.items())
    host = verified[0][1]['host']
    deferred = any(receipt.get('streamAcceptance') == 'deferred' for _, receipt in verified)
    acceptance = ('本次按“先发布、后验收”提供完整功能包；**包内实际视频／音频串流验收尚未完成**。'
                  if deferred else '包内视频／音频串流验收状态见各架构下载元数据。')
    capabilities = ('包含 Mac 被控端、远控客户端及配对剪贴板。' if host else
                    '包含配对剪贴板文字／图片收发、远程控制 Windows／其他已支持的电脑，以及内置连接组件。此版不包含 Mac 被控端；不能用它接收其他设备的远程桌面连接。')
    notes = f'''# ClipRelay macOS {version}

{capabilities}

提供 Apple Silicon（arm64，M 系列）和 Intel（x64）两个 ZIP。{minimum}。

## 安装

1. 根据“关于本机”中的芯片或处理器选择下载包，解压后将 `ClipRelay.app` 拖入“应用程序”。
2. 本版使用 ad-hoc 签名，**未经过 Apple Developer ID 签名或公证**。首次打开可能被 Gatekeeper 拦截。确认下载来源与 SHA-256 后，先尝试打开，再进入“系统设置 → 隐私与安全性 → 仍要打开”。参见 [Apple 官方说明](https://support.apple.com/zh-cn/102445)。受管理的 Mac 可能不允许添加例外。
3. 根据系统提示授予所需权限。从菜单栏打开 ClipRelay，按应用内提示添加／配对电脑。
4. 如果曾使用 Hammerspoon 版本，先停用旧 ClipRelay 并 Reload；保留旧配置供首次导入。

下载目录中可运行 `shasum -a 256 -c SHA256SUMS` 核对两个安装包；只下载一个时，比较 `shasum -a 256 文件名.zip` 与对应记录。

## 验证范围

两种架构均经过原生 CI 构建、剪贴板与登录项检查、包内源码和组件摘要核对。{acceptance}Apple Silicon CI 虚拟机无法呈现 Metal 画面，ARM 远控实际画面尚未完成实机验收；此次未进行用户 Mac 安装、系统权限弹窗、真实登录或两台电脑端到端验收。

源码提交：`{commit}`。构建与完整检查记录：[GitHub Actions]({REPOSITORY}/actions/runs/{run})。`macos-update.json` 和 `SHA256SUMS` 记录版本、架构及下载摘要。
'''
    (output / 'release-notes.md').write_text(notes, encoding='utf-8')
    print(json.dumps(metadata))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--run', required=True)
    parser.add_argument('--allow-deferred-stream', action='store_true')
    args = parser.parse_args()
    prepare(args.artifacts, args.output, args.commit, args.run, args.allow_deferred_stream)

import sys, json, zipfile, pathlib, plistlib, stat, hashlib
manifest=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
release=pathlib.Path(manifest['release']);version=manifest['version']
project=pathlib.Path(__file__).resolve().parents[1]

def project_docs(output,prefix=''):
    for source,target in [('README.md','README.md'),('LICENSE','LICENSE.project'),('docs/使用说明.md','docs/使用说明.md')]:
        output.write(project/source,prefix+target)
def entry(name,data,mode=0o644):
    info=zipfile.ZipInfo(name);info.create_system=3;info.external_attr=(stat.S_IFREG|mode)<<16;info.compress_type=zipfile.ZIP_DEFLATED
    return info,data
win=pathlib.Path(manifest['win'])
with zipfile.ZipFile(release/f'chatbox-{version}-Windows-x64.zip','w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as output:
    for file in win.rglob('*'):
        if file.is_file():output.write(file,'chatbox/'+file.relative_to(win).as_posix())
    project_docs(output,'chatbox/')
script='''#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$SCRIPT_DIR/chatbox.app"
if [ ! -d "$APP/Contents/MacOS" ]; then echo "请把本脚本放在 chatbox.app 旁边。"; exit 1; fi
if [ ! -w "$APP" ]; then echo "请先将整个文件夹复制到本机可写位置后运行。"; exit 1; fi
/usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
if ! /usr/bin/codesign --verify --deep "$APP" >/dev/null 2>&1; then
  /usr/bin/codesign --force --deep --sign - "$APP"
fi
# Direct launch inherits this Terminal session environment. Finder/open may not.
exec "$APP/Contents/MacOS/chatbox"
'''
for mac in manifest['mac']:
    target=release/f"chatbox-{version}-Mac-{mac['arch']}.zip"
    with zipfile.ZipFile(mac['file']) as source, zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as output:
        for info in source.infolist():
            if not info.filename.startswith('Electron.app/'):
                if info.filename in ('LICENSE','LICENSES.chromium.html','version'):output.writestr(info,source.read(info))
                continue
            data=source.read(info);info.filename=info.filename.replace('Electron.app/','chatbox.app/',1)
            if info.filename=='chatbox.app/Contents/MacOS/Electron':info.filename='chatbox.app/Contents/MacOS/chatbox'
            if info.filename=='chatbox.app/Contents/Info.plist':
                config=plistlib.loads(data);config.update(CFBundleExecutable='chatbox',CFBundleName='chatbox',CFBundleDisplayName='chatbox',CFBundleIdentifier='local.chatbox',CFBundleShortVersionString=version,CFBundleVersion=version,
                    NSMicrophoneUsageDescription='用于转写您选择的麦克风声音。',NSAudioCaptureUsageDescription='用于实时转写系统播放的面试声音。',NSScreenCaptureUsageDescription='用于截取您选择的问题区域及获取系统声音。')
                data=plistlib.dumps(config)
            output.writestr(info,data)
        output.write(manifest['asar'],'chatbox.app/Contents/Resources/app.asar')
        for name,data,mode in [('启动chatbox.command',script.encode(),0o755),('使用说明.txt',manifest['readme'].encode(),0o644)]:
            info,data=entry(name,data,mode);output.writestr(info,data)
        project_docs(output)
    print(f'Created {target.name}',flush=True)
hashes=[]
for file in release.glob('*.zip'):
    digest=hashlib.file_digest(file.open('rb'),'sha256').hexdigest();hashes.append(f'{digest}  {file.name}');print(f'{file.name}: {file.stat().st_size//1048576} MiB',flush=True)
(release/'SHA256SUMS.txt').write_text('\n'.join(hashes)+'\n',encoding='utf-8')

import base64
import json
from pathlib import Path
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')

root = Path(__file__).resolve().parents[1]
worker = subprocess.Popen([sys.executable, '-u', str(root / 'scripts/asr.py')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding='utf-8', cwd=root)
try:
    for line in worker.stdout:
        msg = json.loads(line)
        print(json.dumps(msg, ensure_ascii=False), flush=True)
        if msg['type'] == 'error':
            raise RuntimeError(msg['message'])
        if msg['type'] == 'ready':
            break
    else:
        raise RuntimeError('Speech worker exited before ready')
    raw = (root / 'artifacts/speech-test.wav').read_bytes()
    started = time.monotonic()
    worker.stdin.write(json.dumps({'audio': base64.b64encode(raw).decode()}) + '\n')
    worker.stdin.flush()
    msg = json.loads(worker.stdout.readline())
    text = msg.get('text', '')
    result = {'ok': msg['type'] == 'transcript' and ('数据库' in text or 'database' in text.lower()), 'text': text, 'seconds': round(time.monotonic() - started, 2)}
    (root / 'artifacts/asr-check.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False), flush=True)
    if not result['ok']:
        raise RuntimeError('No transcript returned')
finally:
    worker.terminate()
    worker.wait(timeout=15)

"""Evaluate frozen predictions against human BPMs; labels never enter the detector."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--limit', type=int)
    p.add_argument('--output', type=Path, default=ROOT / '.auto-tag/benchmark.json')
    args = p.parse_args()
    entries = [e for e in json.loads((ROOT / 'public/clips/manifest.json').read_text()) if e.get('bpm') is not None]
    if args.limit:
        entries = entries[:args.limit]
    engine_hash = hashlib.sha256((ROOT / 'scripts/auto_tag/scan.py').read_bytes()).hexdigest()
    rows = []
    for i, entry in enumerate(entries):
        command = [sys.executable, str(ROOT / 'scripts/auto_tag/scan.py'), '--file', str(ROOT / 'public/clips' / entry['file']), '--start', str(entry.get('trimStart') or 0)]
        if entry.get('trimEnd') is not None:
            command += ['--end', str(entry['trimEnd'])]
        started = time.monotonic()
        row = {'id': entry['id'], 'file': entry['file'], 'expectedBpm': entry['bpm'], 'predictedBpm': None, 'absoluteError': None, 'exact': False, 'octaveEquivalent': False}
        try:
            proc = subprocess.run(command, capture_output=True, text=True, timeout=720)
            messages = [json.loads(line) for line in proc.stdout.splitlines() if line.startswith('{')]
            result = next((m['result'] for m in messages if m.get('type') == 'result'), None)
            if proc.returncode or not result:
                raise RuntimeError(next((m['message'] for m in messages if m.get('type') == 'error'), proc.stderr[-800:]))
            predicted = result['bpm'];expected = entry['bpm']; tolerance = max(2, .03 * expected)
            row.update(predictedBpm=predicted, method=result['method'], confidence=result['confidence'], candidates=result['candidates'], warnings=result['warnings'])
            if predicted is not None:
                row.update(absoluteError=abs(predicted - expected), exact=abs(predicted - expected) <= tolerance, octaveEquivalent=any(abs(predicted * scale - expected) <= tolerance for scale in [.5, 1, 2]))
        except Exception as error:
            row['error'] = str(error)
        row['elapsedSeconds'] = round(time.monotonic() - started, 2)
        rows.append(row)
        report = {'engineHash': engine_hash, 'version': 'beta-1', 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'total': len(entries), 'processed': len(rows), 'proposed': sum(r['predictedBpm'] is not None for r in rows), 'exact': sum(r['exact'] for r in rows), 'octaveEquivalent': sum(r['octaveEquivalent'] for r in rows), 'rows': rows}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + '\n')
        print(f"{i+1}/{len(entries)} {entry['file']}: expected={entry['bpm']:.1f}, predicted={row['predictedBpm']}, exact={row['exact']}, octave={row['octaveEquivalent']}, seconds={row['elapsedSeconds']}" + (f" ERROR: {row['error']}" if row.get('error') else ''), flush=True)


if __name__ == '__main__':
    main()

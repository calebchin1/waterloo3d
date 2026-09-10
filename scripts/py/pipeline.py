"""Run walkgraph -> stitch -> ocr -> emit for a set of buildings.

    .venv/bin/python scripts/py/pipeline.py MC SLC E5
    .venv/bin/python scripts/py/pipeline.py --core     # the tunnel network
    .venv/bin/python scripts/py/pipeline.py --all
    .venv/bin/python scripts/py/pipeline.py --core --skip-ocr

corpus.py, extract.py and georef.py run once up front and are not repeated here;
this is the per-building half of the chain, which is what gets re-run while
tuning.
"""
import argparse, json, os, subprocess, sys, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PY = os.path.join(ROOT, '.venv', 'bin', 'python')
HERE = os.path.dirname(os.path.abspath(__file__))


def core_codes():
    c = json.load(open(os.path.join(ROOT, 'public', 'data', 'connections.geojson')))
    return sorted({p for f in c['features'] for p in (f['properties']['from'], f['properties']['to'])})


def georeferenced(code):
    p = os.path.join(ROOT, 'data', 'georef', f'{code}.json')
    return os.path.exists(p) and 'scale' in json.load(open(p))


def run(step, code):
    r = subprocess.run([PY, os.path.join(HERE, f'{step}.py'), code], capture_output=True, text=True)
    if r.returncode:
        print(f'    {step} FAILED: {r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "?"}')
        return None
    return r.stdout.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('codes', nargs='*')
    ap.add_argument('--core', action='store_true', help='buildings on the tunnel/bridge network')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--skip-ocr', action='store_true')
    a = ap.parse_args()

    if a.all:
        codes = sorted({json.load(open(os.path.join(ROOT, 'data', 'georef', f)))['code']
                        for f in os.listdir(os.path.join(ROOT, 'data', 'georef')) if f.endswith('.json')})
    elif a.core:
        codes = core_codes()
    else:
        codes = a.codes
    codes = [c for c in codes if georeferenced(c)]
    if not codes:
        sys.exit('nothing to build')

    print(f'{len(codes)} buildings: {" ".join(codes)}\n', flush=True)
    done, failed = [], []
    for n, code in enumerate(codes, 1):
        t0 = time.time()
        print(f'[{n}/{len(codes)}] {code}', flush=True)
        if run('walkgraph', code) is None: failed.append(code); continue
        if run('stitch', code) is None: failed.append(code); continue
        if not a.skip_ocr and run('ocr', code) is None: failed.append(code); continue
        out = run('emit', code)
        if out is None: failed.append(code); continue
        print(f'    {out.splitlines()[0].strip()}  ({time.time() - t0:.0f}s)', flush=True)
        done.append(code)
    print(f'\nbuilt {len(done)}, failed {len(failed)}' + (f': {" ".join(failed)}' if failed else ''))


if __name__ == '__main__':
    main()

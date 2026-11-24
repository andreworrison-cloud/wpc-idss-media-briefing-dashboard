"""Collect the four reviewed impact products independently for one Pages release."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import aviation
import exposure
import ground
import power


def collect_impacts(board, review, now=None):
    now = now or datetime.now(timezone.utc)
    checks = {'power': (power.collect, (now,)), 'aviation': (aviation.collect, (now,)),
              'exposure': (exposure.collect, (board, now)), 'ground': (ground.collect, (board, now))}
    results = {}
    with ThreadPoolExecutor(max_workers=len(checks)) as pool:
        pending = {key: pool.submit(fn, *args) for key, (fn, args) in checks.items()}
        for key, future in pending.items():
            try:
                snapshot = future.result()
                if not isinstance(snapshot, dict) or snapshot.get('status') not in {'current', 'ok', 'partial', 'unavailable', 'stale'}:
                    raise ValueError('Unknown impact product status')
                review(snapshot)
                results[key] = snapshot
            except Exception as error:
                print(f'{key} unavailable: {type(error).__name__}: {error}', flush=True)
                results[key] = {'status': 'unavailable', 'checked_at': now.isoformat().replace('+00:00', 'Z')}
    return results

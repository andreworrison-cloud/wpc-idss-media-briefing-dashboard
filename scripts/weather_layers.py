"""Collect the public geographic layers independently at the IDSS publishing site."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from functools import partial

import hydro_layers
import report_layers
import winter_layers


def collect_weather(board, review, now=None, *, radar_images=None):
    now = now or datetime.now(timezone.utc)
    stamp = now.isoformat(timespec='seconds').replace('+00:00', 'Z')
    definitions = {
        'hydro': (partial(hydro_layers.collect, radar_images=radar_images), (now,), ('radar', 'mpd')),
        'winter': (winter_layers.collect, (now,), ('winter',)),
        'observations': (report_layers.collect, (now, board), ('observations',)),
    }
    weather = {}
    with ThreadPoolExecutor(max_workers=len(definitions)) as executor:
        jobs = {name: executor.submit(fn, *args) for name, (fn, args, _) in definitions.items()}
        for name, future in jobs.items():
            keys = definitions[name][2]
            try:
                payload = future.result()
            except Exception as exc:
                print(f'{name} collection failed ({type(exc).__name__}).', flush=True)
                payload = {}
            for key in keys:
                value = payload.get(key) if name == 'hydro' and isinstance(payload, dict) else payload
                try:
                    if not isinstance(value, dict) or value.get('status') not in {
                        'ok', 'current', 'none', 'partial', 'stale', 'unavailable',
                    }:
                        raise ValueError('Unknown geographic layer status')
                    review(value)
                    weather[key] = value
                except (ValueError, TypeError, KeyError) as exc:
                    print(f'{key} unavailable: {exc}', flush=True)
                    weather[key] = {'status': 'unavailable', 'checked_at': stamp}
    return weather

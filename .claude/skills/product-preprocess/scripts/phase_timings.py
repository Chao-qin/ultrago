from contextlib import contextmanager
import time


class PhaseTimings:
    def __init__(self, clock=None):
        self._clock = clock or time.monotonic
        self._started_at = self._clock()
        self._stages = {}
        self._stage_order = []
        self._active = None

    def _remember(self, name):
        if name not in self._stages and name not in self._stage_order:
            self._stage_order.append(name)

    def _record(self, name, started_at, status):
        duration_ms = max(0, round((self._clock() - started_at) * 1000))
        observed = self._stages.get(name)
        if observed is None:
            self._stages[name] = {
                'name': name,
                'durationMs': duration_ms,
                'status': status,
            }
            return
        observed['durationMs'] += duration_ms
        if status == 'failed':
            observed['status'] = 'failed'

    @contextmanager
    def stage(self, name):
        self._remember(name)
        started_at = self._clock()
        status = 'success'
        try:
            yield
        except BaseException:
            status = 'failed'
            raise
        finally:
            self._record(name, started_at, status)

    def start_stage(self, name):
        self.finish_stage()
        self._remember(name)
        self._active = (name, self._clock())

    def finish_stage(self, status='success'):
        if self._active is None:
            return
        name, started_at = self._active
        self._active = None
        self._record(name, started_at, status)

    def snapshot(self):
        return {
            'totalMs': max(0, round((self._clock() - self._started_at) * 1000)),
            'stages': [dict(self._stages[name]) for name in self._stage_order if name in self._stages],
        }

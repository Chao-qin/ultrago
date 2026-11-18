import json
import math
import os
import sys
from dataclasses import dataclass


TEXT_CHARS_PER_UNIT = 4_000
FLOW_FINISH_GRACE_SECONDS = 30


@dataclass(frozen=True)
class InspectionBudget:
    total_seconds: float
    image_request_seconds: float
    text_request_seconds: tuple[float, ...]
    workers: int


def plan_inspection(batches, texts, *, workers, unit_seconds):
    if batches < 0 or workers < 1 or not math.isfinite(unit_seconds) or unit_seconds <= 0:
        raise ValueError('检测任务量、并发数或单元预算无效')
    active_workers = min(workers, batches) if batches else 0
    text_seconds = tuple(math.ceil(len(text) / TEXT_CHARS_PER_UNIT) * unit_seconds for text in texts)
    # 客户端并发不能证明模型服务也能并行推理，单请求需容纳同批请求的排队时间。
    return InspectionBudget(
        total_seconds=batches * unit_seconds + sum(text_seconds),
        image_request_seconds=active_workers * unit_seconds,
        text_request_seconds=text_seconds,
        workers=active_workers,
    )


def announce_work(stage, seconds):
    if os.environ.get('BCP_FLOW_BUDGET_PROTOCOL') != '1':
        return
    if not math.isfinite(seconds) or seconds <= 0:
        return
    packet = {'stage': stage, 'remainingMs': math.ceil((seconds + FLOW_FINISH_GRACE_SECONDS) * 1_000)}
    print('BCP_BUDGET_V1 ' + json.dumps(packet, separators=(',', ':')), file=sys.stderr, flush=True)

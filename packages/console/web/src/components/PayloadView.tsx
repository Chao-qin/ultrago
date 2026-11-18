import { Space, Tag, Tooltip, Typography } from "antd";
import { ExportOutlined, FileOutlined, WarningOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { splitOutputProblems } from "@bcp/shared";
import type { SchemaRecordRow } from "../lib/types";
import { ContentView } from './content-view';

/**
 * One landed payload, rendered from its `SchemaRecord` row.
 *
 * A row goes down one of two branches and they display differently, which is
 * the whole reason this is a component rather than a `<pre>` at each call site:
 * the payload branch has the bytes in `data` and can show them, while the file
 * branch has only a pointer — a payload can be 28MB, and inlining it into a
 * page that polls every 2s is not a display choice anyone made on purpose.
 *
 * `record` is a FULL row, never a `SchemaRecordListRow`: `record.data !== null`
 * below only works when `data` is really there. A list row has no `data` key at
 * all, so it cannot get in here — measured, because the error code depends on
 * the position: TS2741 as a JSX prop ("Property 'data' is missing"), TS2345 in
 * argument position, and TS2339 if the predicate itself were spelled against a
 * list row. Any of the three beats the alternative, which is a branch that
 * silently sends every file row down the payload path.
 *
 * Both run detail and flow run detail read the same shape, so they share this
 * rather than each inventing a rendering of the same row.
 */
/** `schemaErrors` 的两半：真违约 / 校验器没实现的部分。分错一半就会把
 *  「我们没查」说成「它违规」，所以拆解只做一次，两个调用方都用它。
 *
 *  `null` 表示「这串东西根本读不出条目」（无契约、空串、坏 JSON）。它和
 *  `{ violations: [], notices: [] }` 不是一回事：后者是「读到了，读出来是空」，
 *  该按合约通过显示；前者什么都不知道，必须闭嘴。 */
function splitProblems(errors: string | null): { violations: string[]; notices: string[] } | null {
  if (errors === null) return null;
  let problems: string[] = [];
  try {
    const parsed: unknown = JSON.parse(errors);
    problems = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return null;
  }
  const { violations, notices } = splitOutputProblems(problems);
  return { violations, notices };
}

export function PayloadView({ record, chrome = 'stacked' }: {
  record: SchemaRecordRow;
  /**
   * `stacked` —— 默认。自带一行元信息（类型 / 大小 / 契约），适合把它当作
   *   面板主体直接铺开，`RunDetail` 就是这么用的。
   * `artifact` —— 调用方自己有卡片头部，所以这里不再重复那行元信息；文件支
   *   也从「一行裸链接」升级成一条可下载、带类型与产成时间的工件行。
   *
   * 两种形态共用下面同一处判支（`data !== null`），这是刻意的：分支逻辑只留
   * 一份，才不会出现某个调用方悄悄把文件行当载荷渲染。
   */
  chrome?: 'stacked' | 'artifact';
}) {
  if (chrome === 'artifact') {
    const notices = splitProblems(record.schemaErrors)?.notices ?? [];
    return (
      <>
        {record.data !== null
          ? <ContentView value={record.data} contentType={record.contentType} maxHeight={360} />
          : <ArtifactFileRow record={record} />}
        {notices.length > 0 && (
          <p className='frd-output-notice'>
            <WarningOutlined />
            <span>有 {notices.length} 条契约约束未被校验器实现，这部分没有校验过 —— 既不代表通过，也不代表违反。</span>
          </p>
        )}
      </>
    );
  }
  return (
    <>
      <Space size={8} style={{ marginBottom: 8 }} wrap>
        <Typography.Text type="secondary">{record.contentType}</Typography.Text>
        {record.schemaName && <Tag>{record.schemaName}@{record.schemaVersion}</Tag>}
        <Typography.Text type="secondary">{record.bytes}B</Typography.Text>
        <ContractTag errors={record.schemaErrors} />
      </Space>
      {record.data !== null ? (
        <ContentView value={record.data} contentType={record.contentType} maxHeight={360} />
      ) : (
        <div>
          {/* No preview on purpose — see the component comment. The link is the
              product; guessing at a size that is safe to inline would be a
              second rule to keep in sync with the one that put it here. */}
          <a href={record.url ?? undefined} download>{record.fileName}</a>
        </div>
      )}
    </>
  );
}

/** 文件支的产出，按「工件」而不是「一段文字」来呈现。
 *
 *  它只有指针没有本体（载荷可能几十 MB，见上面的组件注释），所以卡片能给的
 *  信息就是这颗指针的全部属性：叫什么、什么类型、多大、什么时候产出的、
 *  怎么拿走。排成一行以后，这张卡才不是在说「这里有个 JSON 文件名」。 */
function ArtifactFileRow({ record }: { record: SchemaRecordRow }) {
  const href = record.url ?? undefined;
  return (
    <div className='frd-output-file'>
      <span className='frd-output-file-icon'><FileOutlined /></span>
      <div className='frd-output-file-main'>
        <a className='frd-output-file-name' href={href} download>{record.fileName ?? '未命名产出'}</a>
        <span className='frd-output-file-meta'>
          {/* 大小只在卡片头部出现一次。头部对「载荷支」也成立，行本身只有文件支
              才会渲染 —— 把大小放头部，两支都不会漏，也不会重复。 */}
          <span>{record.contentType}</span>
          <span>产出于 {dayjs(record.createdAt).format('MM-DD HH:mm:ss')}</span>
        </span>
      </div>
      {href && (
        <a className='frd-output-file-open' href={href} target='_blank' rel='noreferrer'>
          <ExportOutlined /> 新标签打开
        </a>
      )}
    </div>
  );
}

/** The output contract verdict for a landed payload.
 *
 *  Four states, deliberately distinguishable — and the fourth is why the entry
 *  COUNT is not the verdict. `schemaErrors` mixes two kinds of entry, so a
 *  non-empty list used to render as 违反合约 even when the value conformed to
 *  every constraint the validator implements and the only entry was the
 *  validator admitting it does not implement `minItems`. Calling that a breach
 *  is a false accusation, so the list is split first (`splitOutputProblems`)
 *  and each half gets its own tag:
 *
 *    no tag       — no contract was declared, so nothing was checked
 *    合约通过      — checked in full, and conforming
 *    违反合约      — checked and violating, problems on hover
 *    未完全校验    — part of the schema is beyond the validator, so those
 *                   constraints went unverified. NOT a verdict on the data:
 *                   it can sit next to 违反合约 (some checks ran and failed) or
 *                   stand alone (the checks that ran passed, others never ran).
 *                   What it must never do is read as either a pass or a breach.
 *
 *  A violation never fails a standalone run — it is reported here so a drifting
 *  book surfaces before a downstream consumer trips over it. (Inside a flow it
 *  IS fatal; the flow runner enforces that, and it splits the list the same
 *  way so a notice does not stop a flow.) */
export function ContractTag({ errors }: { errors: string | null }) {
  const split = splitProblems(errors);
  if (!split) return null;
  const { violations, notices } = split;
  return (
    <>
      {violations.length > 0 ? (
        <Tooltip title={<div>{violations.map((p) => <div key={p}>{p}</div>)}</div>}>
          <Tag color="red">违反合约 · {violations.length} 项</Tag>
        </Tooltip>
      ) : (
        // Only when nothing went unchecked either — "the part we can check
        // passed" is not a pass, and green would say it was.
        notices.length === 0 && <Tag color="green">合约通过</Tag>
      )}
      {notices.length > 0 && (
        <Tooltip title={<div>{notices.map((p) => <div key={p}>{p}</div>)}</div>}>
          <Tag color="orange">未完全校验</Tag>
        </Tooltip>
      )}
    </>
  );
}

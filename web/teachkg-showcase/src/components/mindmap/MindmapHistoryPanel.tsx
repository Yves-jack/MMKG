import type { MindmapHistoryItem } from "@/lib/apps/mindmapEdits";
import pipe from "@/pages/PipelinePage.module.css";

/** 右栏操作历史：仅最新一步可撤销（逐步回退，不可跳撤销中间步） */
export function MindmapHistoryPanel({
  items,
  onUndo,
}: {
  items: MindmapHistoryItem[];
  onUndo: () => void;
}) {
  if (!items.length) {
    return (
      <div className={pipe.sideEmpty}>
        暂无操作记录。开启编辑并改动导图后，步骤会显示在此。
      </div>
    );
  }

  const newestFirst = [...items].reverse();

  return (
    <div className={pipe.kgEditBox}>
      <label className={pipe.kgEditLabel}>最近操作（逐步撤销）</label>
      <small className={pipe.kgEditHint}>
        只能撤销最近一步；更早步骤需连续撤销。快捷键 Ctrl+Z。
      </small>
      {newestFirst.map((item, i) => {
        const isLatest = i === 0;
        return (
          <div key={`${item.at}-${i}-${item.label}`} className={pipe.kgDeletedRow}>
            <code title={item.label}>{item.label}</code>
            {isLatest ? (
              <button
                type="button"
                className={pipe.kgEditBtnGhost}
                title="撤销这一步"
                onClick={onUndo}
              >
                撤销
              </button>
            ) : (
              <span className={pipe.kgEditHint} style={{ flexShrink: 0 }} title="请先撤销更新的步骤">
                —
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

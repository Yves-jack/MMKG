import type { LinkedKnowledgeResource } from "@/lib/integration/knowledgeResources";
import { resourceTitle } from "@/components/graph/LinkedResourceCards";
import { LatexText } from "@/components/graph/LatexText";
import styles from "./MasteryResourceBranches.module.css";

type Kind = LinkedKnowledgeResource["resource_type"];
const kinds: Kind[] = ["video", "exercise", "animation", "formula"];
const titles: Record<Kind, string> = {
  video: "视频",
  exercise: "题目",
  animation: "动画",
  formula: "公式与例子",
};

type Branch = { kind: Kind | "empty" | "loading" | "error"; resources: LinkedKnowledgeResource[] };

export function MasteryResourceBranches({
  anchor,
  canvas,
  resources,
  loading,
  error,
  onOpen,
  onClose,
}: {
  anchor: { x: number; y: number };
  canvas: { width: number; height: number };
  resources: LinkedKnowledgeResource[];
  loading: boolean;
  error: string;
  onOpen: (resource: LinkedKnowledgeResource) => void;
  onClose: () => void;
}) {
  const groups: Branch[] = loading
    ? [{ kind: "loading", resources: [] }]
    : error
      ? [{ kind: "error", resources: [] }]
      : kinds
          .map((kind) => ({ kind, resources: resources.filter((item) => item.resource_type === kind) }))
          .filter((group) => group.resources.length > 0);
  if (!groups.length) groups.push({ kind: "empty", resources: [] });

  const { width, height } = canvas;
  const narrow = width < 620;
  const gap = 9;
  const columns = narrow && width >= 350 ? 2 : 1;
  const rows = Math.ceil(groups.length / columns);
  const onlyState = groups.length === 1 && !groups[0].resources.length;
  const cardWidth = narrow
    ? Math.max(145, (width - 24 - gap * (columns - 1)) / columns)
    : onlyState ? 200 : Math.min(260, Math.max(190, width * 0.32));
  const cardHeight = narrow
    ? Math.min(112, Math.max(76, (height * 0.48 - gap * (rows - 1)) / rows))
    : onlyState ? 72 : Math.min(134, Math.max(82, (height - 24 - gap * (rows - 1)) / rows));
  const stackHeight = cardHeight * rows + gap * (rows - 1);
  const onLeft = !narrow && anchor.x > width * 0.52;
  const left = narrow ? 8 : onLeft
    ? Math.max(8, anchor.x - cardWidth - 64)
    : Math.min(width - cardWidth - 8, anchor.x + 64);
  const top = narrow
    ? Math.max(8, height - stackHeight - 8)
    : Math.max(8, Math.min(height - stackHeight - 8, anchor.y - stackHeight / 2));

  return (
    <div className={styles.overlay} aria-label="节点关联资源">
      <svg className={styles.links} width={width} height={height} aria-hidden="true">
        {groups.map((group, index) => {
          const col = narrow ? index % columns : 0;
          const row = narrow ? Math.floor(index / columns) : index;
          const x = left + col * (cardWidth + gap);
          const y = top + row * (cardHeight + gap);
          const targetX = narrow ? x + cardWidth / 2 : onLeft ? x + cardWidth : x;
          const targetY = narrow ? y : y + cardHeight / 2;
          const midX = (anchor.x + targetX) / 2;
          return (
            <path
              key={group.kind}
              d={`M ${anchor.x} ${anchor.y} C ${midX} ${anchor.y}, ${midX} ${targetY}, ${targetX} ${targetY}`}
              className={styles.link}
            />
          );
        })}
        <circle cx={anchor.x} cy={anchor.y} r="5" className={styles.origin} />
      </svg>
      {groups.map((group, index) => {
        const col = narrow ? index % columns : 0;
        const row = narrow ? Math.floor(index / columns) : index;
        const heading = group.kind === "empty" ? "相关资源" : group.kind === "loading" ? "相关资源" : group.kind === "error" ? "资源暂不可用" : titles[group.kind];
        return (
          <section
            key={group.kind}
            className={`${styles.card} ${styles[group.kind]}`}
            style={{ left: left + col * (cardWidth + gap), top: top + row * (cardHeight + gap), width: cardWidth, height: cardHeight }}
          >
            <header className={styles.header}>
              <strong>{heading}</strong>
              {index === 0 ? <button type="button" className={styles.close} aria-label="关闭关联资源" title="关闭关联资源" onClick={onClose}>×</button> : null}
              {group.resources.length ? <span className={styles.count}>{group.resources.length}</span> : null}
            </header>
            <div className={styles.body}>
              {group.kind === "loading" ? "正在读取关联资源…" : null}
              {group.kind === "error" ? error : null}
              {group.kind === "empty" ? "此节点暂无关联资源" : null}
              {group.resources.map((resource, itemIndex) => {
                const text = resourceTitle(resource, titles[resource.resource_type]);
                const key = `${resource.resource_type}:${resource.resource_id}:${itemIndex}`;
                return resource.resource_type === "formula" ? (
                  <div className={styles.formulaItem} key={key}>
                    <LatexText compact text={String(resource.content || text)} />
                  </div>
                ) : (
                  <button className={styles.resourceButton} type="button" key={key} title={text} onClick={() => onOpen(resource)}>
                    {text}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

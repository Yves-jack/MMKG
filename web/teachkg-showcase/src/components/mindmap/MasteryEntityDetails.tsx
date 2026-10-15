import { useEffect, useState } from "react";
import { courseDataUrl } from "@/lib/course";
import { LatexText } from "@/components/graph/LatexText";
import {
  createMasteryEntityIndex,
  masteryEntityDetails,
  type MasteryEntityIndex,
} from "@/lib/kg/masteryEntityDetails.mjs";
import styles from "./MasteryNodeDetails.module.css";
const cache = new Map<string, Promise<MasteryEntityIndex>>();
function load(courseId: string) {
  let promise = cache.get(courseId);
  if (!promise) {
    const json = async (path: string) => {
      const response = await fetch(courseDataUrl(courseId, path));
      if (!response.ok) throw new Error("实体数据暂不可用");
      return response.json();
    };
    promise = Promise.allSettled([
      json("pipeline/kg_processed_course.json"),
      json("entity_definitions.json"),
    ]).then(([graph, definitions]) => {
      const nodes =
        graph.status === "fulfilled" && Array.isArray(graph.value?.nodes)
          ? graph.value.nodes
          : [];
      const defs =
        definitions.status === "fulfilled" &&
        definitions.value &&
        typeof definitions.value === "object"
          ? definitions.value
          : {};
      if (graph.status === "rejected" || definitions.status === "rejected")
        cache.delete(courseId);
      return createMasteryEntityIndex(nodes, defs);
    });
    cache.set(courseId, promise);
  }
  return promise;
}
export function MasteryEntityDetails({
  courseId,
  node,
}: {
  courseId: string;
  node: { id: string; zh: string };
}) {
  const [state, setState] = useState<{
    course: string;
    index: MasteryEntityIndex;
  } | null>(null);
  useEffect(() => {
    let active = true;
    load(courseId).then((index) => {
      if (active) setState({ course: courseId, index });
    });
    return () => {
      active = false;
    };
  }, [courseId]);
  const info = masteryEntityDetails(
    node,
    state?.course === courseId ? state.index : createMasteryEntityIndex(),
  );
  return (
    <div className={styles.entityInfo}>
      {info.canonical !== node.zh ? (
        <p className={styles.canonical}>
          <LatexText compact text={info.canonical} />
        </p>
      ) : null}
      <div className={styles.aliases}>
        <span>别名</span>
        <div>
          {info.aliases.length ? (
            info.aliases.map((alias) => (
              <span className={styles.alias} key={alias}>
                <LatexText compact text={alias} />
              </span>
            ))
          ) : (
            <span className={styles.emptyDetail}>暂无别名</span>
          )}
        </div>
      </div>
      <details key={node.id} className={styles.definition} open>
        <summary>实体定义</summary>
        <div>
          {state?.course !== courseId ? (
            "正在读取实体定义…"
          ) : info.definition ? (
            <LatexText compact as="div" text={info.definition} />
          ) : (
            <span className={styles.emptyDetail}>词条库暂无该实体定义</span>
          )}
        </div>
      </details>
    </div>
  );
}

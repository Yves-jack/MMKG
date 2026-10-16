type ResourceNode<TNode> = {
  children?: TNode[];
};

type ResourceQuery = {
  entityId?: string | null;
  entityAliases?: string[];
  matchMode?: string;
};

export function aggregateMindmapResourceQueries<
  TNode extends ResourceNode<TNode>,
  TQuery extends ResourceQuery,
>(node: TNode, directQuery: (node: TNode) => TQuery | null): TQuery[];

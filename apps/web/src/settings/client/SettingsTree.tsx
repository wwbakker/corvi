import { type JSX, useState } from "react";

/**
 * The settings tree: the sections grouped the way the settings divide, with a filter above them.
 *
 * Every node is selectable, including a group that owns no settings of its own — a tree whose
 * group rows do nothing reads as broken. Groups start open, and a filter opens whatever it
 * matches so a match is never hidden behind a collapsed parent.
 */
export type SettingsTreeNode = {
  readonly id: string;
  readonly label: string;
  /** The sections under a group; absent on a leaf. */
  readonly children?: readonly SettingsTreeNode[];
};

/** A node as the filter leaves it, with the children that survived it. */
type Branch = {
  readonly node: SettingsTreeNode;
  readonly children: readonly Branch[];
};

/** Every node under `nodes`, unfiltered — what a matching group shows below it. */
const withAllChildren = (nodes: readonly SettingsTreeNode[]): readonly Branch[] =>
  nodes.map((node) => ({ node, children: withAllChildren(node.children ?? []) }));

/**
 * What a query keeps: a node whose label matches keeps everything under it, and a node whose
 * label does not still shows when something under it matches.
 */
const withMatches = (nodes: readonly SettingsTreeNode[], query: string): readonly Branch[] => {
  const keep = (node: SettingsTreeNode): Branch | undefined => {
    if (node.label.toLowerCase().includes(query)) {
      return { node, children: withAllChildren(node.children ?? []) };
    }
    const children = (node.children ?? []).flatMap((child) => keep(child) ?? []);
    return children.length ? { node, children } : undefined;
  };
  return nodes.flatMap((node) => keep(node) ?? []);
};

export function SettingsTree({
  nodes,
  selected,
  onSelect,
}: {
  nodes: readonly SettingsTreeNode[];
  /** The node whose settings the detail pane is showing. */
  selected: string;
  onSelect: (id: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  // The groups the reader closed. A filter overrides them: seeing a match is worth more than
  // remembering where the reader was, and the closed groups come back when the filter clears.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const filtering = query.trim().length > 0;
  const visible = filtering ? withMatches(nodes, query.trim().toLowerCase()) : withAllChildren(nodes);

  // A filter forces every group open, so a toggle during one would only write a state nobody can
  // see — and snap groups shut when the filter clears. The control is disabled while it lasts.
  const toggle = (id: string): void => {
    if (filtering) return;
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="settings-tree">
      <input
        className="settings-filter"
        type="search"
        aria-label="Filter settings"
        placeholder="Filter"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {/* The filter stays at the top: the scroll container below is the tree, not the column. */}
      <div className="tree-scroll">
        <ul className="tree" aria-label="Settings sections">
          {visible.map((branch) => (
            <TreeBranch
              key={branch.node.id}
              branch={branch}
              selected={selected}
              filtering={filtering}
              collapsed={collapsed}
              onToggle={toggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
        {visible.length === 0 && <p className="hint">nothing matches</p>}
      </div>
    </div>
  );
}

function TreeBranch({
  branch,
  selected,
  filtering,
  collapsed,
  onToggle,
  onSelect,
}: {
  branch: Branch;
  selected: string;
  filtering: boolean;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { node, children } = branch;
  const hasChildren = Boolean(node.children?.length);
  const open = filtering || !collapsed.has(node.id);
  return (
    <li className={hasChildren ? "tree-branch group" : "tree-branch"}>
      <div className="row">
        {hasChildren ? (
          <button
            className="toggle"
            aria-label={`${open ? "Collapse" : "Expand"} ${node.label}`}
            aria-expanded={open}
            disabled={filtering}
            onClick={() => onToggle(node.id)}
          >
            {open ? "\u2212" : "+"}
          </button>
        ) : (
          <span className="toggle-space" aria-hidden="true" />
        )}
        <button
          className={node.id === selected ? "node current" : "node"}
          aria-current={node.id === selected ? "true" : undefined}
          onClick={() => onSelect(node.id)}
        >
          {node.label}
        </button>
      </div>
      {open && children.length > 0 && (
        <ul className="children">
          {children.map((child) => (
            <TreeBranch
              key={child.node.id}
              branch={child}
              selected={selected}
              filtering={filtering}
              collapsed={collapsed}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

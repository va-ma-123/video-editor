// Groups are a purely organizational overlay: `project.clips` stays flat and
// IS the actual playback order. A group is just a name + collapsed flag
// wrapping a *contiguous* run of that flat array, tracked via `clip.group_id`
// pointing at its immediate group, and `group.parent_group_id` for nesting.
//
// This file builds a displayable nested tree from that flat representation,
// and implements the mutations (group/ungroup) that keep it consistent.

import { defaultGroupOperations } from "./edl";

export function descendantGroupIds(groups, groupId) {
  const result = [];
  Object.values(groups).forEach((g) => {
    if (g.id === groupId) return;
    let current = g.parent_group_id;
    while (current) {
      if (current === groupId) {
        result.push(g.id);
        return;
      }
      current = groups[current]?.parent_group_id || null;
    }
  });
  return result;
}

export function newGroupId() {
  return "group_" + Math.random().toString(16).slice(2, 12);
}

// Returns the chain of ancestor group ids for a clip, outermost first.
// e.g. a clip directly in group B, where B is nested in group A, returns [A, B].
function ancestorChain(groupId, groups) {
  const chain = [];
  let current = groupId;
  while (current && groups[current]) {
    chain.unshift(current);
    current = groups[current].parent_group_id || null;
  }
  return chain;
}

/**
 * Build a nested tree for rendering from the flat clips array + groups dict.
 * Each clip node carries its `flatIndex`. Each group node carries the
 * inclusive [startIndex, endIndex] flat-index range it spans, so drag/drop
 * and group-level actions (move, ungroup) can operate on the real array.
 *
 * This is a bracket-matching walk: as we scan clips in order, we open a group
 * node the first time we see its id in a clip's ancestor chain, and close it
 * once we move past the last clip that has it in its chain. Because it's
 * driven purely by the flat array's actual order, this can never produce an
 * invalid/overlapping tree -- if a group's clips were ever non-contiguous
 * (shouldn't happen if group/ungroup/drag stay disciplined, but not fatal if
 * it does), the same group id would just render as two separate blocks
 * rather than crashing.
 */
export function buildTimelineTree(clips, groups) {
  const root = { type: "root", children: [] };
  const stack = [root]; // stack of currently-open group nodes, root at bottom
  const stackIds = []; // parallel array of group ids for the open group nodes

  clips.forEach((clip, flatIndex) => {
    const chain = ancestorChain(clip.group_id, groups);

    // Find how much of the currently-open stack this clip's chain still shares.
    let common = 0;
    while (common < stackIds.length && common < chain.length && stackIds[common] === chain[common]) {
      common++;
    }

    // Close any open groups beyond the shared prefix, recording their end index.
    while (stackIds.length > common) {
      stackIds.pop();
      const node = stack.pop();
      node.endIndex = flatIndex - 1;
    }

    // Open any new groups needed for the remainder of this clip's chain.
    for (let i = common; i < chain.length; i++) {
      const groupId = chain[i];
      const node = { type: "group", group: groups[groupId], startIndex: flatIndex, endIndex: null, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
      stackIds.push(groupId);
    }

    stack[stack.length - 1].children.push({ type: "clip", clip, flatIndex });
  });

  // Close any groups still open at the end of the array.
  while (stackIds.length > 0) {
    stackIds.pop();
    const node = stack.pop();
    node.endIndex = clips.length - 1;
  }

  return root.children;
}

// Returns [startIndex, endIndex] (inclusive) for a group id, or null if the
// group currently has no clips. Used by "move this group" drag and ungroup.
// Needs `groups` too, since a clip might belong to a nested child group of
// the group being asked about.
export function groupSpan(clips, groups, groupId) {
  let start = null;
  let end = null;
  clips.forEach((clip, i) => {
    const chain = ancestorChain(clip.group_id, groups);
    if (chain.includes(groupId)) {
      if (start === null) start = i;
      end = i;
    }
  });
  return start === null ? null : [start, end];
}

/**
 * Can the flat range [startIndex, endIndex] be wrapped in a new group?
 * Valid iff every group that has ANY clip inside the range has ALL of its
 * clips inside the range too (no partial overlap -- would break contiguity
 * for the existing group).
 */
export function canGroupRange(clips, groups, startIndex, endIndex) {
  if (startIndex > endIndex) return { ok: false, reason: "Empty selection" };

  const touchedGroupIds = new Set();
  for (let i = startIndex; i <= endIndex; i++) {
    const chain = ancestorChain(clips[i].group_id, groups);
    chain.forEach((id) => touchedGroupIds.add(id));
  }

  for (const groupId of touchedGroupIds) {
    const span = groupSpan(clips, groups, groupId);
    if (span && (span[0] < startIndex || span[1] > endIndex)) {
      return { ok: false, reason: `"${groups[groupId]?.name || groupId}" is only partly inside the selection` };
    }
  }

  return { ok: true };
}

/**
 * Wrap the flat range [startIndex, endIndex] in a new group with the given
 * name. Only the outermost items touched by the range get reparented (a
 * clip that's already in a fully-contained subgroup keeps its own group_id;
 * the subgroup's `parent_group_id` gets pointed at the new group instead).
 * Returns { groups: updatedGroupsDict, clips: updatedClipsArray, groupId }.
 */
export function groupRange(clips, groups, startIndex, endIndex, name) {
  const groupId = newGroupId();
  const newGroups = { 
    ...groups, 
    [groupId]: { id: groupId, name, collapsed: false, parent_group_id: null, operations: defaultGroupOperations() } };
  const newClips = clips.map((clip, i) => {
    if (i < startIndex || i > endIndex) return clip;
    // Only reparent clips that are currently at the top level (ungrouped) --
    // clips already in a subgroup are handled by reparenting their subgroup below.
    if (!clip.group_id) return { ...clip, group_id: groupId };
    return clip;
  });

  // Reparent any top-level subgroups within the range to the new group.
  const topLevelGroupIdsInRange = new Set();
  for (let i = startIndex; i <= endIndex; i++) {
    if (clips[i].group_id) {
      const chain = ancestorChain(clips[i].group_id, groups);
      if (chain.length > 0 && !newGroups[chain[0]].parent_group_id) {
        topLevelGroupIdsInRange.add(chain[0]);
      }
    }
  }
  topLevelGroupIdsInRange.forEach((id) => {
    newGroups[id] = { ...newGroups[id], parent_group_id: groupId };
  });

  return { groups: newGroups, clips: newClips, groupId };
}

/**
 * Remove a group wrapper without touching its clips or contents. Clips/subgroups
 * that were direct children move up to whatever level the removed group was at.
 */
export function ungroup(clips, groups, groupId) {
  const target = groups[groupId];
  if (!target) return { clips, groups };

  const newGroups = { ...groups };
  delete newGroups[groupId];

  // Any subgroup directly parented to this group moves up to this group's own parent.
  Object.values(newGroups).forEach((g) => {
    if (g.parent_group_id === groupId) {
      newGroups[g.id] = { ...g, parent_group_id: target.parent_group_id };
    }
  });

  // Any clip directly in this group moves up to this group's parent (or ungrouped).
  const newClips = clips.map((clip) =>
    clip.group_id === groupId ? { ...clip, group_id: target.parent_group_id } : clip
  );

  return { clips: newClips, groups: newGroups };
}

// Drop any group that no longer has any clips (directly or via a nested
// subgroup) anywhere in the flat array -- avoids accumulating dead labels
// after clips get deleted individually rather than via "ungroup".
export function pruneEmptyGroups(clips, groups) {
  const liveGroupIds = new Set();
  clips.forEach((clip) => ancestorChain(clip.group_id, groups).forEach((id) => liveGroupIds.add(id)));
  const newGroups = {};
  Object.keys(groups).forEach((id) => {
    if (liveGroupIds.has(id)) newGroups[id] = groups[id];
  });
  return newGroups;
}

// Move the contiguous slice [fromStart, fromEnd] so it begins at `toIndex`
// (an index in the ORIGINAL array). Used for dragging a whole group as a block.
export function reorderRange(clips, fromStart, fromEnd, toIndex) {
  const slice = clips.slice(fromStart, fromEnd + 1);
  const rest = [...clips.slice(0, fromStart), ...clips.slice(fromEnd + 1)];
  // Recompute where toIndex lands in `rest` once the slice has been removed.
  let adjustedTo = toIndex;
  if (toIndex > fromEnd) adjustedTo -= slice.length;
  else if (toIndex > fromStart) adjustedTo = fromStart; // dropped inside its own old span -- no-op position
  const result = [...rest.slice(0, adjustedTo), ...slice, ...rest.slice(adjustedTo)];
  return result;
}
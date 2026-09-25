import { useState } from "react";
import { estimateClipDuration, formatSec, newClipId } from "../edl";
import {
  buildTimelineTree, groupSpan, canGroupRange, groupRange, ungroup, pruneEmptyGroups, reorderRange,
  duplicateGroup,
} from "../groups";

export default function Timeline({ project, selectedClipId, selectedGroupId, playingClipId, onSelect, onSelectGroup, onChange }) {
  const groups = project.groups || {};
  const clips = project.clips;
  const playingFlatIndex = playingClipId ? clips.findIndex((c) => c.id === playingClipId) : -1;

  const [draggedItem, setDraggedItem] = useState(null); // {type:'clip', flatIndex} | {type:'group', groupId, start, end}
  const [dragOverFlatIndex, setDragOverFlatIndex] = useState(null);
  const [anchor, setAnchor] = useState(null); // {start, end} of the last plain-clicked row
  const [selectedRange, setSelectedRange] = useState(null); // [lo, hi] flat indices, for grouping

  const commit = (patch) => onChange({ ...project, ...patch });

  // --- basic clip actions (unchanged behavior, now group_id-aware where relevant) ---

  const remove = (clipId) => {
    const newClips = clips.filter((c) => c.id !== clipId);
    commit({ clips: newClips, groups: pruneEmptyGroups(newClips, groups) });
  };

  const duplicate = (index) => {
    const clip = clips[index];
    const copy = { ...clip, id: newClipId(), operations: JSON.parse(JSON.stringify(clip.operations)) };
    const newClips = [...clips];
    newClips.splice(index + 1, 0, copy); // same group_id as original, inserted right next to it -- stays contiguous
    commit({ clips: newClips });
  };

  const split = (index) => {
    const clip = clips[index];
    const mid = Math.floor((clip.start_frame + clip.end_frame) / 2);
    if (mid <= clip.start_frame || mid >= clip.end_frame) return;
    const first = { ...clip, id: newClipId(), start_frame: clip.start_frame, end_frame: mid };
    const second = { ...clip, id: newClipId(), start_frame: mid, end_frame: clip.end_frame };
    const newClips = [...clips];
    newClips.splice(index, 1, first, second); // both keep the original's group_id
    commit({ clips: newClips });
    // Splitting the currently-selected clip replaces its id -- carry the
    // selection onto the first half rather than leaving it dangling.
    if (clip.id === selectedClipId) onSelect(first.id);
  };

  // --- grouping actions ---

  const handleCreateGroup = () => {
    if (!selectedRange) return;
    const [lo, hi] = selectedRange;
    const check = canGroupRange(clips, groups, lo, hi);
    if (!check.ok) return; // button is disabled in this case anyway
    const name = window.prompt("Name this group", "New Group");
    if (!name) return;
    const result = groupRange(clips, groups, lo, hi, name);
    commit({ clips: result.clips, groups: result.groups });
    setSelectedRange(null);
    setAnchor(null);
  };

  const handleToggleCollapse = (groupId) => {
    commit({ groups: { ...groups, [groupId]: { ...groups[groupId], collapsed: !groups[groupId].collapsed } } });
  };

  const handleRename = (groupId) => {
    const name = window.prompt("Rename group", groups[groupId].name);
    if (!name) return;
    commit({ groups: { ...groups, [groupId]: { ...groups[groupId], name } } });
  };

  const handleDuplicateGroup = (groupId) => {
  console.log("1. Duplicate clicked for Group ID:", groupId);
  console.log("2. Current clips before duplicate:", clips);
  console.log("3. Current groups before duplicate:", groups);

  const result = duplicateGroup(clips, groups, groupId);
  console.log("4. Resulting clips after duplicate:", result.clips);
  console.log("5. Resulting groups after duplicate:", result.groups);

  // Test both or verify which one updates your App state
  commit({ clips: result.clips, groups: result.groups });
};

  const handleUngroup = (groupId) => {
    const result = ungroup(clips, groups, groupId);
    commit(result);
  };

  const handleDeleteGroup = (groupId) => {
    const span = groupSpan(clips, groups, groupId);
    if (!span) return;
    const [lo, hi] = span;
    const count = hi - lo + 1;
    if (!window.confirm(`Delete "${groups[groupId].name}" and its ${count} clip${count === 1 ? "" : "s"}?`)) return;
    const newClips = [...clips.slice(0, lo), ...clips.slice(hi + 1)];
    // Removing every clip in the span empties this group AND any nested
    // subgroups inside it, so pruning cleans up the whole subtree for free.
    commit({ clips: newClips, groups: pruneEmptyGroups(newClips, groups) });
  };

  // --- selection (single-click = editor selection + shift-click anchor; shift-click = extend range) ---

  const handleRowClick = (e, span, clipIdForEditor, groupIdForSelection) => {
    if (e.shiftKey && anchor) {
      setSelectedRange([Math.min(anchor.start, span.start), Math.max(anchor.end, span.end)]);
    } else {
      setAnchor(span);
      setSelectedRange(null);
      if (clipIdForEditor) onSelect(clipIdForEditor);
      else if (groupIdForSelection) onSelectGroup(groupIdForSelection);
    }
  };

  // --- drag and drop ---

  const containerGroupIdFor = (node) =>
    node.type === "clip" ? node.clip.group_id || null : node.group.parent_group_id || null;

  const handleDragStart = (e, node) => {
    e.stopPropagation();
    if (node.type === "clip") {
      setDraggedItem({ type: "clip", flatIndex: node.flatIndex });
    } else {
      setDraggedItem({ type: "group", groupId: node.group.id, start: node.startIndex, end: node.endIndex });
    }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "drag");
  };

  const handleDragOver = (e, node) => {
    e.preventDefault();
    e.stopPropagation();
    const targetStart = node.type === "clip" ? node.flatIndex : node.startIndex;
    if (targetStart !== dragOverFlatIndex) setDragOverFlatIndex(targetStart);
  };

  const handleDrop = (e, node) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFlatIndex(null);
    if (!draggedItem) return;

    const targetStart = node.type === "clip" ? node.flatIndex : node.startIndex;
    const targetContainerGroupId = containerGroupIdFor(node);

    if (draggedItem.type === "clip") {
      const patched = clips.map((c, i) =>
        i === draggedItem.flatIndex ? { ...c, group_id: targetContainerGroupId } : c
      );
      const updated = reorderRange(patched, draggedItem.flatIndex, draggedItem.flatIndex, targetStart);
      commit({ clips: updated, groups: pruneEmptyGroups(updated, groups) });
    } else {
      // Group-block drag: v1 only supports reordering among the group's
      // current siblings, not re-nesting it under a different parent --
      // dropping somewhere that would change its nesting level is a no-op.
      const draggedGroupParent = groups[draggedItem.groupId]?.parent_group_id || null;
      if (targetContainerGroupId !== draggedGroupParent) return;
      const updated = reorderRange(clips, draggedItem.start, draggedItem.end, targetStart);
      commit({ clips: updated });
    }
    setDraggedItem(null);
  };

  const handleDragEnd = () => {
    setDraggedItem(null);
    setDragOverFlatIndex(null);
  };

  // --- rendering ---

  const badgesFor = (clip) => {
    const badges = [];
    const ops = clip.operations;
    if (ops.reverse) badges.push("reverse");
    if (ops.speed.factor !== 1.0) badges.push(`${ops.speed.factor}x`);
    if (ops.freeze_frame) badges.push("freeze");
    if (ops.transform.rotate) badges.push(`rot${ops.transform.rotate}`);
    if (ops.transform.crop) badges.push("crop");
    if (ops.transform.flip) badges.push(ops.transform.flip);
    // A clip inside a group: "inherit" is the do-nothing default (defers to
    // the group), so anything else -- including an explicit "original" --
    // is worth flagging, since it means this clip deliberately overrides
    // whatever its group says.
    //
    // A standalone clip has no group to defer to, so "inherit" and
    // "original" resolve identically at render time (both just fall back to
    // plain original audio) -- flagging "inherit" there would badge every
    // untouched clip for no reason. Only a genuine effect (muted/replaced/
    // metronome) is worth a badge in that case.
    const noOpAudioModes = clip.group_id ? ["inherit"] : ["inherit", "original"];
    if (!noOpAudioModes.includes(ops.audio.mode)) badges.push(ops.audio.mode);
    if (ops.fade.fade_in.duration_sec > 0 || ops.fade.fade_out.duration_sec > 0) badges.push("fade");
    return badges;
  };

  const renderClipRow = (node, depth) => {
    const clip = node.clip;
    const source = project.sources[clip.source_id];
    const fps = source?.fps || 30;
    const duration = estimateClipDuration(clip, fps);
    const isSelected = clip.id === selectedClipId;
    const isPlaying = node.flatIndex === playingFlatIndex;
    const isDragging = draggedItem?.type === "clip" && draggedItem.flatIndex === node.flatIndex;
    const isDragOver = dragOverFlatIndex === node.flatIndex && !isDragging;
    const inRange = selectedRange && node.flatIndex >= selectedRange[0] && node.flatIndex <= selectedRange[1];
    const badges = badgesFor(clip);

    return (
      <div
        key={clip.id}
        draggable
        onDragStart={(e) => handleDragStart(e, node)}
        onDragOver={(e) => handleDragOver(e, node)}
        onDrop={(e) => handleDrop(e, node)}
        onDragEnd={handleDragEnd}
        className={`timeline-clip ${isSelected ? "selected" : ""} ${isPlaying ? "playing" : ""} ${isDragging ? "dragging" : ""} ${isDragOver ? "drag-over" : ""} ${inRange ? "range-selected" : ""}`}
        onClick={(e) => handleRowClick(e, { start: node.flatIndex, end: node.flatIndex }, clip.id)}
      >
        <div className="clip-drag-handle" title="Drag to reorder">⠿</div>
        <div className="clip-index">{isPlaying ? " ▶" : node.flatIndex + 1}</div>
        <div className="clip-info">
          <div className="clip-name">{source?.source_kind === "image" ? "🖼️ " : ""}{source?.filename || clip.source_id}</div>
          <div className="clip-meta mono">
            f{clip.start_frame}–{clip.end_frame} · {formatSec(duration)}
          </div>
          {badges.length > 0 && (
            <div className="clip-badges">
              {badges.map((b) => <span key={b} className="badge">{b}</span>)}
            </div>
          )}
        </div>
        <div className="clip-actions" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => duplicate(node.flatIndex)} title="Duplicate (useful for looping)">⧉</button>
          <button onClick={() => split(node.flatIndex)} title="Split at midpoint">split</button>
          <button onClick={() => remove(clip.id)} title="Delete" className="danger">×</button>
        </div>
      </div>
    );
  };

  const renderGroupNode = (node, depth) => {
    const group = node.group;
    const isSelected = group.id === selectedGroupId;
    const containsPlaying = playingFlatIndex >= node.startIndex && playingFlatIndex <= node.endIndex;
    const isDragging = draggedItem?.type === "group" && draggedItem.groupId === group.id;
    const isDragOver = dragOverFlatIndex === node.startIndex && !isDragging;
    const inRange = selectedRange && node.startIndex >= selectedRange[0] && node.endIndex <= selectedRange[1];
    const clipCount = node.endIndex - node.startIndex + 1;
    // Older projects saved before group-level operations existed won't have
    // this field yet -- treat that the same as an explicit "inherit".
    const groupAudioMode = group.operations?.audio?.mode || "inherit";

    return (
      <div key={group.id}>
        <div
          draggable
          onDragStart={(e) => handleDragStart(e, node)}
          onDragOver={(e) => handleDragOver(e, node)}
          onDrop={(e) => handleDrop(e, node)}
          onDragEnd={handleDragEnd}
          className={`timeline-group-header ${isSelected ? "selected" : ""} ${containsPlaying ? "contains-playing" : ""} ${isDragging ? "dragging" : ""} ${isDragOver ? "drag-over" : ""} ${inRange ? "range-selected" : ""}`}
          onClick={(e) => handleRowClick(e, { start: node.startIndex, end: node.endIndex }, null, group.id)}
        >
          <div className="clip-drag-handle" title="Drag to move whole group">⠿</div>
          <button
            className="group-toggle"
            onClick={(e) => { e.stopPropagation(); handleToggleCollapse(group.id); }}
            title={group.collapsed ? "Expand" : "Collapse"}
          >
            {group.collapsed ? "▸" : "▾"}
          </button>
          <div className="group-info">
            <span className="group-name">{containsPlaying ? "▶" : "📁"} {group.name}</span>
            <span className="dim mono"> ({clipCount} clip{clipCount === 1 ? "" : "s"})</span>
            {groupAudioMode !== "inherit" && (
              <span className="clip-badges"><span className="badge">{groupAudioMode}</span></span>
            )}
          </div>
          <div className="clip-actions" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => handleRename(group.id)} title="Rename group">✎</button>
            <button onClick={() => handleDuplicateGroup(group.id)} title="Duplicate group">⧉</button>
            <button onClick={() => handleUngroup(group.id)} title="Ungroup (keeps clips)">ungroup</button>
            <button onClick={() => handleDeleteGroup(group.id)} title="Delete group and its clips" className="danger">×</button>
          </div>
        </div>
        {!group.collapsed && (
          <div className="timeline-group-children">
            {node.children.map((child) => (child.type === "clip" ? renderClipRow(child, depth + 1) : renderGroupNode(child, depth + 1)))}
          </div>
        )}
      </div>
    );
  };

  if (clips.length === 0) {
    return <div className="timeline empty">No clips yet. Mark an in/out range above and add it.</div>;
  }

  const tree = buildTimelineTree(clips, groups);
  const groupCheck = selectedRange ? canGroupRange(clips, groups, selectedRange[0], selectedRange[1]) : null;

  return (
    <div className="timeline">
      {selectedRange && (
        <div className="group-action-bar">
          <span className="dim">{selectedRange[1] - selectedRange[0] + 1} item(s) selected</span>
          {groupCheck.ok ? (
            <button className="primary" onClick={handleCreateGroup}>Group these</button>
          ) : (
            <span className="dim" title={groupCheck.reason}>Can't group: {groupCheck.reason}</span>
          )}
          <button onClick={() => { setSelectedRange(null); setAnchor(null); }}>Cancel</button>
        </div>
      )}
      {!selectedRange && (
        <div className="group-hint">
          💡 <strong>Shift-click</strong> another clip to select a range, then group them.
        </div>
      )}
      {tree.map((node) => (node.type === "clip" ? renderClipRow(node, 0) : renderGroupNode(node, 0)))}
    </div>
  );
}
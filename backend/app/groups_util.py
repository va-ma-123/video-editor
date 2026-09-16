"""
Clip <-> group membership helpers. Mirrors the ancestor-chain logic the
frontend uses to build its group tree (see frontend/src/groups.js) -- kept
here as the one shared implementation rather than duplicated between
main.py's group preview/continuation endpoints and metronome.py's audio
resolution, which both need it.
"""
from __future__ import annotations

from typing import Optional

from .models import Clip, Project


def group_ancestor_chain(group_id: Optional[str], groups: dict) -> list[str]:
    """Outermost-first chain of ancestor group ids for a given group id."""
    chain = []
    current = group_id
    while current and current in groups:
        chain.insert(0, current)
        current = groups[current].parent_group_id
    return chain


def clips_in_group(project: Project, group_id: str) -> list[Clip]:
    """All clips belonging to a group, directly or via a nested subgroup,
    in their existing timeline order."""
    result = []
    for clip in project.clips:
        chain = group_ancestor_chain(clip.group_id, project.groups)
        if group_id in chain:
            result.append(clip)
    return result
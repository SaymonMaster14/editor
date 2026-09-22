/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Agent Access: the filesystem boundary the host enforces for every chat.
// Project only (the default), project plus approved folders with per-folder
// read/write grants, or explicit full machine access. Changes apply to newly
// opened sessions and persist in the host's access.json.

import { For, Show, createSignal } from "solid-js";
import { toast } from "somoto";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItemLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";

import type { AccessState } from "@diffusionstudio/agent-chat";

import { chatState, ensureConnected, refreshAccess, setAccess } from "./store";

function accessLabel(access: AccessState | null): string {
  if (!access) return "Access";
  if (access.mode === "full") return "Full access";
  return access.roots.length === 0 ? "Project only" : `Project + ${access.roots.length}`;
}

function accessIcon(access: AccessState | null): string {
  if (!access || access.mode === "project") return access && access.roots.length > 0 ? "folders-icon" : "lock-closed";
  return "lock-open";
}

export function AccessMenu() {
  ensureConnected();
  const access = () => chatState.access;
  const [draft, setDraft] = createSignal("");
  const [draftWrite, setDraftWrite] = createSignal(false);

  const apply = (next: AccessState) => {
    setAccess(next).catch((error: Error) => toast.error("Could not update access", { description: error.message }));
  };

  const addRoot = () => {
    const path = draft().trim();
    const current = access();
    if (!path || !current) return;
    if (current.roots.some((root) => root.path === path)) {
      toast.error("Folder already approved");
      return;
    }
    apply({ mode: "project", roots: [...current.roots, { path, write: draftWrite() }] });
    setDraft("");
    setDraftWrite(false);
  };

  return (
    <DropdownMenu placement="bottom-end" onOpenChange={(open) => open && refreshAccess()}>
      <DropdownMenuTrigger
        as="button"
        type="button"
        aria-label="Agent filesystem access"
        class="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-450 text-muted-foreground hover:bg-muted focus-ring"
      >
        <Icon name={accessIcon(access())} class="size-5" />
        <span class="max-w-28 truncate">{accessLabel(access())}</span>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent class="w-72">
          <DropdownMenuGroup>
            <DropdownMenuGroupLabel>Agent Access</DropdownMenuGroupLabel>
            <DropdownMenuRadioGroup value={access()?.mode ?? "project"} onChange={(mode) => mode === "full" || mode === "project" ? apply({ mode, roots: access()?.roots ?? [] }) : undefined}>
              <DropdownMenuRadioItem value="project">
                <span class="min-w-0 flex-1">
                  <span class="block truncate">Project only</span>
                  <span class="block truncate text-[10px] text-muted-foreground">Agents change just the open project</span>
                </span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="full">
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-destructive">Full machine access</span>
                  <span class="block truncate text-[10px] text-muted-foreground">Agents may change anything</span>
                </span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <Show when={(access()?.roots.length ?? 0) > 0 || access()?.mode === "project"}>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuGroupLabel>Approved folders</DropdownMenuGroupLabel>
              <For each={access()?.roots ?? []}>
                {(root) => (
                  <div class="flex items-center gap-1 px-2 py-1">
                    <span class="min-w-0 flex-1 truncate text-xs" title={root.path}>
                      {root.path}
                    </span>
                    <button
                      type="button"
                      title={root.write ? "Read/write — switch to read-only" : "Read-only — switch to read/write"}
                      onClick={() => {
                        const current = access();
                        if (!current) return;
                        apply({ mode: "project", roots: current.roots.map((entry) => (entry.path === root.path ? { ...entry, write: !entry.write } : entry)) });
                      }}
                      class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-550 text-muted-foreground hover:bg-muted"
                    >
                      {root.write ? "RW" : "RO"}
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${root.path}`}
                      onClick={() => {
                        const current = access();
                        if (!current) return;
                        apply({ mode: "project", roots: current.roots.filter((entry) => entry.path !== root.path) });
                      }}
                      class="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted"
                    >
                      <Icon name="close-remove-small" class="size-4" />
                    </button>
                  </div>
                )}
              </For>
              <div class="flex items-center gap-1 px-2 py-1">
                <input
                  type="text"
                  value={draft()}
                  onInput={(event) => setDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") addRoot();
                    event.stopPropagation();
                  }}
                  placeholder="Folder path…"
                  aria-label="Folder path"
                  class="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-ring"
                />
                <button
                  type="button"
                  title={draftWrite() ? "Read/write" : "Read-only"}
                  onClick={() => setDraftWrite(!draftWrite())}
                  class="h-7 shrink-0 rounded-md border border-input px-1.5 text-[10px] font-550 text-muted-foreground hover:bg-muted"
                >
                  {draftWrite() ? "RW" : "RO"}
                </button>
                <button
                  type="button"
                  aria-label="Approve folder"
                  onClick={addRoot}
                  class="grid size-7 shrink-0 place-items-center rounded-md border border-input text-muted-foreground hover:bg-muted"
                >
                  <Icon name="plus-add-small" class="size-4" />
                </button>
              </div>
            </DropdownMenuGroup>
          </Show>
          <DropdownMenuSeparator />
          <DropdownMenuItemLabel>
            <span class="text-[10px] leading-4 text-muted-foreground">Applies to newly opened sessions. Reads outside stay allowed; writes are scoped.</span>
          </DropdownMenuItemLabel>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenu>
  );
}

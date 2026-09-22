/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createMemo, createSignal } from "solid-js";
import { toast } from "somoto";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useLibrary } from "@/engine/library";
import { importInternetAsset, searchInternet } from "@/engine/internet-import";

import type { AssetCandidate, AssetKind, ProviderSearchOutcome } from "@diffusionstudio/assets/internet";

type KindFilter = "all" | AssetKind;

const KIND_FILTERS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "video", label: "Videos" },
  { id: "gif", label: "GIFs" },
];

/**
 * Internet stock search: the same provider fan-out and the same guarded
 * import the agent uses, behind a human panel. Search runs in the desktop
 * app's main process; importing stores local project bytes with provenance,
 * and the asset lands in the Project library ready to drag to the timeline.
 */
export function SearchPanel() {
  const library = useLibrary();
  const [query, setQuery] = createSignal("");
  const [kind, setKind] = createSignal<KindFilter>("all");
  const [searching, setSearching] = createSignal(false);
  const [importing, setImporting] = createSignal<string | null>(null);
  const [candidates, setCandidates] = createSignal<AssetCandidate[]>([]);
  const [outcomes, setOutcomes] = createSignal<ProviderSearchOutcome[]>([]);
  const [searched, setSearched] = createSignal(false);

  const desktop = () => typeof window !== "undefined" && !!window.desktop;

  const failed = createMemo(() => outcomes().filter((outcome) => outcome.error));

  const search = async () => {
    const q = query().trim();
    if (!q || searching()) return;
    setSearching(true);
    try {
      const kinds = kind() === "all" ? undefined : [kind() as AssetKind];
      const result = await searchInternet(q, kinds);
      setCandidates(result.candidates);
      setOutcomes(result.outcomes);
      setSearched(true);
    } catch (error) {
      toast.error("Search failed", { description: (error as Error).message });
    } finally {
      setSearching(false);
    }
  };

  const keyOf = (candidate: AssetCandidate): string => `${candidate.provider}:${candidate.remoteId}`;

  const importCandidate = async (candidate: AssetCandidate) => {
    const lib = library();
    if (!lib || importing()) return;
    const key = keyOf(candidate);
    setImporting(key);
    try {
      const { name } = await importInternetAsset(lib, { candidate, query: query().trim() || undefined });
      toast.success("Imported", { description: `${name} is in the Project library.` });
    } catch (error) {
      toast.error("Import failed", { description: (error as Error).message });
    } finally {
      setImporting(null);
    }
  };
  const metaOf = (candidate: AssetCandidate): string => {
    const parts: string[] = [candidate.provider, candidate.kind];
    if (candidate.width && candidate.height) parts.push(`${candidate.width}×${candidate.height}`);
    if (candidate.duration) parts.push(`${Math.round(candidate.duration * 10) / 10}s`);
    return parts.join(" · ");
  };

  return (
    <div class="flex flex-col h-full overflow-hidden">
      <Show
        when={desktop()}
        fallback={
          <div class="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
            <Icon name="search" class="size-8 text-muted-foreground" />
            <p class="text-xs text-muted-foreground">Internet search runs in the desktop app, where downloads stay guarded.</p>
          </div>
        }
      >
        <div class="px-3 py-2 flex flex-col gap-1.5">
          <input
            type="text"
            placeholder="Search stock photos, videos, GIFs"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") void search();
            }}
            class="w-full text-xs bg-input border border-border rounded-md outline-none px-2 py-1.5 text-foreground placeholder:text-muted-foreground focus:border-primary"
          />
          <div class="flex items-center gap-1">
            <For each={KIND_FILTERS}>
              {(filter) => (
                <Button
                  size="small"
                  variant={kind() === filter.id ? "default" : "ghost"}
                  class={kind() === filter.id ? "" : "text-muted-foreground"}
                  onClick={() => setKind(filter.id)}
                >
                  {filter.label}
                </Button>
              )}
            </For>
            <Button
              size="small"
              variant="default"
              class="ml-auto"
              disabled={!query().trim() || searching()}
              onClick={() => void search()}
            >
              {searching() ? "Searching…" : "Search"}
            </Button>
          </div>
        </div>
        <div class="flex-1 overflow-y-auto px-1.5 pb-3">
          <For each={candidates()}>
            {(candidate) => (
              <div class="flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-accent group">
                <img
                  src={candidate.thumbnail.url}
                  alt=""
                  loading="lazy"
                  class="size-10 shrink-0 rounded object-cover bg-muted"
                  onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                />
                <span class="flex-1 min-w-0">
                  <span class="block text-xs text-foreground truncate" title={candidate.title}>{candidate.title}</span>
                  <span class="block text-xxs text-muted-foreground truncate">{metaOf(candidate)}</span>
                  <span class="block text-xxs text-muted-foreground truncate" title={candidate.author ?? candidate.license.name}>
                    {candidate.license.name}{candidate.author ? ` · ${candidate.author}` : ""}
                  </span>
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  class="text-muted-foreground shrink-0"
                  disabled={!library() || importing() !== null}
                  onClick={() => void importCandidate(candidate)}
                  title={library() ? "Import into Project library" : "Open a project first"}
                >
                  <Show when={importing() === keyOf(candidate)} fallback={<Icon name="download" />}>
                    <Icon name="spinner-loader" />
                  </Show>
                </Button>
              </div>
            )}
          </For>
          <Show when={searched() && candidates().length === 0 && !searching()}>
            <p class="text-xs text-muted-foreground text-center py-8">No stock found. Try another search.</p>
          </Show>
          <Show when={failed().length > 0}>
            <div class="px-2 py-2">
              <For each={failed()}>
                {(outcome) => (
                  <p class="text-xxs text-muted-foreground py-0.5">{outcome.provider}: {outcome.error}</p>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

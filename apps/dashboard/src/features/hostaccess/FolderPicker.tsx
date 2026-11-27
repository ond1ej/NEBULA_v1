// Directory picker + authorisation form for a host project folder (GET /host/browse, POST /host/roots).
import { useId, useState, type FormEvent } from 'react';
import { IconArrowLeft, IconChevronRight, IconGitHub, IconLock } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Badge, Button, Checkbox, EmptyState, ErrorBanner, Field, Input, LoadingRows, Mono, SegmentedControl, Switch } from '../../components/ui';
import { useApi } from '../../hooks/useApi';
import { IconFolder } from '../files/icons';
import { hostApi } from '../environment/api';
import type { BrowseDir, HostRoot, HostTool, RootMode } from '../environment/types';

/** Breadcrumb parts of an absolute path: [{label, path}] from "/" downwards. */
export function pathCrumbs(path: string): { label: string; path: string }[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((p, i) => ({ label: p, path: `/${parts.slice(0, i + 1).join('/')}` }));
}

/**
 * What the network switch of a host folder does (the host sandbox, VM-03): off by default; on lets commands reach the
 * Internet and the local network. Loopback and unix sockets stay blocked either way, so tools that talk to a local
 * daemon over a socket (the Docker CLI) or to services on 127.0.0.1 cannot do that from a host folder. Seatbelt cannot
 * filter by address, so services this Mac offers on its LAN address stay reachable while the network is on.
 */
export const NETWORK_NOTE =
  'Off by default. When on, commands in this folder can reach the Internet and your local network, including services this Mac offers on its LAN address (package installs, git fetch/push). Loopback (localhost) and unix sockets, such as the Docker daemon and the VM control socket, stay blocked either way.';

export function RootOptionsFields({
  mode,
  setMode,
  network,
  setNetwork,
  tools,
  setTools,
  detected,
}: {
  mode: RootMode;
  setMode: (m: RootMode) => void;
  network: boolean;
  setNetwork: (v: boolean) => void;
  tools: string[];
  setTools: (t: string[]) => void;
  detected: Record<string, HostTool> | null;
}) {
  const available = Object.entries(detected ?? {})
    .filter(([, t]) => t.available)
    .map(([n]) => n)
    .sort();
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <p className="text-[13px] font-medium text-text">Access</p>
        <SegmentedControl<RootMode>
          label="Folder access mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'read_write', label: 'Read & write' },
            { value: 'read_only', label: 'Read only' },
          ]}
        />
        <p className="text-xs text-muted">
          {mode === 'read_only' ? 'Agents can read, search and build, but cannot change files in the folder.' : 'Agents can create and edit files inside this folder. Deletes still need your approval.'}
        </p>
      </div>
      <Switch checked={network} onChange={setNetwork} label="Network access" description={NETWORK_NOTE} />
      <fieldset className="min-w-0">
        <legend className="text-[13px] font-medium text-text">Allowed developer tools</legend>
        <p className="mt-0.5 mb-2 text-xs text-muted">None selected = every detected tool. Tick tools to restrict commands to them.</p>
        {detected === null ? (
          <LoadingRows rows={2} label="Detecting tools…" />
        ) : available.length === 0 ? (
          <p className="text-xs text-subtle">No developer tools detected on this Mac.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {available.map((n) => (
              <Checkbox key={n} label={<span className="font-mono text-[12.5px]">{n}</span>} checked={tools.includes(n)} onChange={(v) => setTools(v ? [...tools, n] : tools.filter((x) => x !== n))} />
            ))}
          </div>
        )}
      </fieldset>
    </div>
  );
}

function DirRow({ d, already, onOpen, onChoose }: { d: BrowseDir; already: boolean; onOpen: () => void; onChoose: () => void }) {
  const reason = already ? 'Already authorised' : d.authorisable ? null : (d.reason ?? 'This folder cannot be authorised');
  return (
    <li className="flex min-w-0 items-center gap-2 px-2 py-1.5 sm:px-3">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${d.name}`}
        className="flex min-h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 text-left transition-colors hover:bg-white/[0.04] focus-ring touch:min-h-11"
      >
        <IconFolder className="size-4 shrink-0 text-accent-soft" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-text">{d.name}</span>
          {(d.git || d.project_markers.length > 0 || reason) && (
            <span className="mt-0.5 flex flex-wrap items-center gap-1">
              {d.git && (
                <Badge tone="accent" icon={<IconGitHub />}>
                  git
                </Badge>
              )}
              {d.project_markers.map((m) => (
                <Badge key={m}>{m}</Badge>
              ))}
              {reason && <span className="text-2xs text-subtle">{reason}</span>}
            </span>
          )}
        </span>
        <IconChevronRight className="size-3.5 shrink-0 text-subtle" />
      </button>
      <Button size="sm" variant={d.git || d.project_markers.length ? 'primary' : 'secondary'} disabledReason={reason} onClick={onChoose}>
        Choose<span className="sr-only"> {d.name}</span>
      </Button>
    </li>
  );
}

export function FolderPicker({
  open,
  onClose,
  onAdded,
  existing,
  detected,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (r: HostRoot) => void;
  existing: HostRoot[];
  detected: Record<string, HostTool> | null;
}) {
  const toast = useToast();
  const ids = { name: useId(), go: useId() };
  const [path, setPath] = useState<string | null>(null);
  const [goTo, setGoTo] = useState('');
  const [chosen, setChosen] = useState<BrowseDir | null>(null);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<RootMode>('read_write');
  const [network, setNetwork] = useState(false); // host roots default to no network (VM-03)
  const [tools, setTools] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const browse = useApi((s) => (open ? hostApi.browse(path, s) : Promise.resolve(null)), [open, path]);
  const known = new Set(existing.map((r) => r.path));

  const reset = () => {
    setChosen(null);
    setSaveError(null);
  };
  const close = () => {
    if (saving) return;
    reset();
    setPath(null);
    onClose();
  };
  const choose = (d: BrowseDir) => {
    setChosen(d);
    setName(d.name);
    setMode('read_write');
    setNetwork(false);
    setTools([]);
    setSaveError(null);
  };
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!chosen || !name.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await hostApi.addRoot({ path: chosen.path, name: name.trim(), mode, allow_network: network, allowed_tools: tools });
      toast.success(`${r.name} authorised`, r.path);
      reset();
      setPath(null);
      onAdded(r);
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  const data = browse.data;
  return (
    <Modal
      open={open}
      onClose={close}
      dismissible={!saving}
      size="lg"
      title={chosen ? 'Authorise this folder' : 'Choose a project folder'}
      description={
        chosen
          ? 'Host agents will be able to work inside this folder only. Nothing outside it is reachable.'
          : 'Browse your home folder or /Volumes. Folder names only — NEBULA does not read file contents here.'
      }
      footer={
        chosen ? (
          <>
            <Button icon={<IconArrowLeft />} onClick={reset} disabled={saving}>
              Back
            </Button>
            <Button variant="primary" icon={<IconLock />} loading={saving} disabledReason={!name.trim() ? 'Give the folder a name' : null} onClick={() => void submit()}>
              Authorise folder
            </Button>
          </>
        ) : (
          <Button onClick={close}>Cancel</Button>
        )
      }
    >
      {chosen ? (
        <form onSubmit={submit} className="space-y-4">
          <div className="rounded-xl border border-border bg-panel-2 px-3.5 py-3">
            <p className="text-2xs tracking-wide text-subtle uppercase">Folder</p>
            <Mono className="mt-0.5 block break-all text-text">{chosen.path}</Mono>
            {(chosen.git || chosen.project_markers.length > 0) && (
              <div className="mt-2 flex flex-wrap gap-1">
                {chosen.git && <Badge tone="accent">git repository</Badge>}
                {chosen.project_markers.map((m) => (
                  <Badge key={m}>{m}</Badge>
                ))}
              </div>
            )}
          </div>
          <Field htmlFor={ids.name} label="Display name" required>
            <Input id={ids.name} value={name} maxLength={128} onChange={(e) => setName(e.target.value)} data-autofocus />
          </Field>
          <RootOptionsFields mode={mode} setMode={setMode} network={network} setNetwork={setNetwork} tools={tools} setTools={setTools} detected={detected} />
          {saveError ? <ErrorBanner error={saveError} title="Folder not authorised" /> : null}
        </form>
      ) : (
        <div className="space-y-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (goTo.trim()) setPath(goTo.trim());
            }}
          >
            <label htmlFor={ids.go} className="sr-only">
              Go to folder path
            </label>
            <Input id={ids.go} value={goTo} onChange={(e) => setGoTo(e.target.value)} placeholder="~/Projects or /Volumes/Work" className="font-mono text-[13px]" />
            <Button type="submit" disabledReason={!goTo.trim() ? 'Type a path' : null}>
              Go
            </Button>
          </form>
          {data && (
            <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-xs">
              {data.parent && (
                <Button size="xs" variant="ghost" icon={<IconArrowLeft />} onClick={() => setPath(data.parent)}>
                  Up
                </Button>
              )}
              {pathCrumbs(data.path).map((c, i, arr) => (
                <span key={c.path} className="flex min-w-0 items-center gap-1">
                  {i > 0 && <IconChevronRight className="size-3 shrink-0 text-subtle" />}
                  {i === arr.length - 1 ? (
                    <span className="truncate font-medium text-text" aria-current="page">
                      {c.label}
                    </span>
                  ) : (
                    <button type="button" className="truncate rounded text-muted hover:text-text focus-ring" onClick={() => setPath(c.path)}>
                      {c.label}
                    </button>
                  )}
                </span>
              ))}
            </nav>
          )}
          {browse.error ? (
            <ErrorBanner
              error={browse.error}
              title="Cannot open this folder"
              onRetry={() => {
                if (path === null) browse.reload();
                else setPath(null);
              }}
            />
          ) : !data ? (
            <LoadingRows rows={6} label="Loading folders…" />
          ) : data.dirs.length === 0 ? (
            <EmptyState compact icon={<IconFolder />} title="No sub-folders here">
              Hidden and protected folders (Library, .ssh, NEBULA data) are never listed.
            </EmptyState>
          ) : (
            <ul aria-label={`Folders in ${data.path}`} className="max-h-[48vh] divide-y divide-border/60 overflow-y-auto rounded-xl border border-border bg-panel">
              {data.dirs.map((d) => (
                <DirRow key={d.path} d={d} already={known.has(d.path)} onOpen={() => setPath(d.path)} onChoose={() => choose(d)} />
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

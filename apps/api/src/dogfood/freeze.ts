import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface RawMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  time: string | null;
  sourceUuid?: string | null;
  ordinal?: number | null;
  isSystem?: boolean;
  isSidechain?: boolean;
}
export interface RawSession {
  id: string;
  sourceUuid: string | null;
  rootId: string | null;
  time: string | null;
  relatedIds?: string[];
  project?: string | null;
  machine?: string | null;
  sourceRevision?: string | null;
  sourceSessionId?: string | null;
  messages: RawMessage[];
  fingerprint: string;
  groupId: string;
  selectionReasons: string[];
}
export interface FreezeManifest {
  format: "findme-av-dogfood-v0.1";
  id: string;
  createdAt: string;
  sourceFingerprint: string;
  seed: string;
  requestedSessions: number;
  requestedHoldout: number;
  cutoffBefore?: string | null;
  samplingVersion?: string;
  sessions: Array<
    Omit<RawSession, "messages"> & { split: "dev" | "holdout"; messageIds: string[] }
  >;
  independence: "unknown";
  holdoutValidation: "pending";
  sampling?: { availableSessions: number; shortage: number; holdoutShortage: number };
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Coverage hints are sampling labels, never authorship judgments. */
function reasons(session: RawSession): string[] {
  const bodies = session.messages.filter((m) => m.role === "user").map((m) => m.text);
  const result: string[] = [];
  if (bodies.some((t) => t.length >= 2000)) result.push("long-paste");
  if (bodies.some((t) => t.trim().length > 0 && t.trim().length <= 120))
    result.push("short-judgment");
  if (bodies.some((t) => /项目|约束|方案|需求|project|constraint|requirement/i.test(t)))
    result.push("project-constraints");
  if (bodies.some((t) => /纠正|不对|不是|改成|更正|correction|incorrect|actually/i.test(t)))
    result.push("corrections");
  return result.length ? result : ["other-human-participation"];
}

export function selectSessions(input: RawSession[], count: number, holdout: number, seed: string) {
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !Number.isSafeInteger(holdout) ||
    holdout < 0 ||
    holdout > count
  ) {
    throw new Error("Invalid freeze sample sizes");
  }
  // Resolve ancestry before filtering: a non-human bridge still links real sessions.
  const originalById = new Map(input.map((session) => [session.id, session]));
  const ancestors = (session: RawSession): string[] => {
    const seen = new Set<string>();
    const pending = [...(session.relatedIds ?? []), ...(session.rootId ? [session.rootId] : [])];
    while (pending.length) {
      const id = pending.pop();
      if (!id || id === session.id || seen.has(id)) continue;
      seen.add(id);
      const parent = originalById.get(id);
      if (parent?.rootId) pending.push(parent.rootId);
      pending.push(...(parent?.relatedIds ?? []));
    }
    return [...seen].sort();
  };
  const sessions = input
    .filter((s) => s.messages.some((m) => m.role === "user" && m.text.trim()))
    .map((s) => ({
      ...s,
      relatedIds: ancestors(s),
      messages: s.messages.map((m) => ({ ...m })),
      fingerprint: digest(s.messages),
      selectionReasons: reasons(s),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(sessions.map((s) => s.id)).size !== sessions.length)
    throw new Error("Duplicate source session identifiers");
  const parents = sessions.map((_, i) => i);
  const root = (i: number): number => {
    const parent = parents[i];
    if (parent === undefined) throw new Error("Invalid session group index");
    if (parent === i) return i;
    const resolved = root(parent);
    parents[i] = resolved;
    return resolved;
  };
  const keys = new Map<string, number>();
  for (const [i, s] of sessions.entries()) {
    const links = [
      `root:${s.id}`,
      ...(s.rootId ? [`root:${s.rootId}`] : []),
      ...(s.relatedIds ?? []).map((id) => `root:${id}`),
      ...(s.sourceUuid ? [`source:${s.sourceUuid}`] : []),
    ];
    for (const m of s.messages) {
      if (m.role !== "user") continue;
      if (m.sourceUuid) links.push(`message-source:${m.sourceUuid}`);
      const text = m.text.trim();
      // A generic acknowledgement is not an event identity. A substantial exact
      // duplicate is a conservative correlation signal, never proof of one event.
      if (text.length >= 160 && new Set(text).size >= 20) links.push(`body:${digest(text)}`);
    }
    for (const key of links) {
      const prior = keys.get(key);
      if (prior !== undefined) parents[root(i)] = root(prior);
      else keys.set(key, i);
    }
  }
  const groups = new Map<number, RawSession[]>();
  for (const [i, s] of sessions.entries()) {
    const r = root(i);
    groups.set(r, [...(groups.get(r) ?? []), s]);
  }
  const ranked = [...groups.values()]
    .map((group) => {
      const groupId = digest(group.map((s) => s.id));
      for (const s of group) {
        s.groupId = groupId;
      }
      return { group, groupId, hints: [...new Set(group.flatMap((s) => s.selectionReasons))] };
    })
    .sort((a, b) => digest([seed, a.groupId]).localeCompare(digest([seed, b.groupId])));
  const picked: FreezeManifest["sessions"] = [];
  const raw: RawSession[] = [];
  const used = new Set<string>();
  function pick(target: number, split: "dev" | "holdout") {
    let total = 0;
    const buckets = [
      "long-paste",
      "short-judgment",
      "project-constraints",
      "corrections",
      "other-human-participation",
    ];
    while (total < target) {
      let progressed = false;
      for (const hint of buckets) {
        const next = ranked.find(
          (g) => !used.has(g.groupId) && g.hints.includes(hint) && total + g.group.length <= target,
        );
        if (!next) continue;
        used.add(next.groupId);
        total += next.group.length;
        progressed = true;
        for (const session of next.group) {
          raw.push(session);
          const { messages: _, ...entry } = session;
          picked.push({ ...entry, split, messageIds: session.messages.map((m) => m.id) });
        }
      }
      if (!progressed) break;
    }
    return total;
  }
  const actualHoldout = pick(holdout, "holdout");
  pick(count - holdout, "dev");
  return {
    sessions: picked,
    raw,
    availableSessions: sessions.length,
    shortage: count - raw.length,
    holdoutShortage: holdout - actualHoldout,
  };
}

// The helper never opens a writable connection or invokes AgentsView services.
const reader = String.raw`
import sqlite3, json, sys, pathlib, datetime
def run():
    db = sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    db.execute('BEGIN')
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    def table(names): return next((n for n in names if n in tables), None)
    st, mt = table(['sessions', 'session', 'conversations']), table(['messages', 'message', 'conversation_messages'])
    if not st or not mt: raise ValueError()
    def columns(t): return {r[1] for r in db.execute('PRAGMA table_info("' + t + '")')}
    def require(cols, alternatives):
        if not any(n in cols for n in alternatives): raise ValueError()
    sc, mc = columns(st), columns(mt)
    require(sc, ['id', 'session_id', 'conversation_id'])
    for names in [['id','message_id','uuid'],['session_id','conversation_id','session'],['role','speaker','type'],['text','content','body','message']]: require(mc,names)
    common = ['id','session_id','conversation_id','is_deleted','deleted','deleted_at','deleted_time','is_current','current','superseded_at','is_automated','automated','is_agent','is_subagent','is_summary','session_type','kind','type','timestamp','created_at','started_at','time','start_time','uuid','source_uuid']
    session_cols = common + ['session_uuid','external_id','source_session_id','root_id','root_session_id','parent_session_id','parent_id','project','machine','transcript_revision','source_version','session_kind','relationship_type','entrypoint']
    message_cols = common + ['message_id','session','role','speaker','text','content','body','message','sequence','seq','position','message_index','ordinal','index','is_system','is_sidechain']
    def rows(t, cols, allowed):
        chosen=list(dict.fromkeys(n for n in allowed if n in cols))
        # Never SELECT *: in particular thinking_text/token_usage are not personal evidence.
        return [dict(r) for r in db.execute('SELECT '+','.join('"'+n+'"' for n in chosen)+' FROM "'+t+'"')]
    ss, mm = rows(st,sc,session_cols), rows(mt,mc,message_cols)
    def value(r,names): return next((r[n] for n in names if n in r and r[n] not in (None,'')),None)
    def truth(v): return v not in (None,False,0,'','0','false','False')
    def deleted(r): return any(truth(r.get(k)) for k in ['is_deleted','deleted','deleted_at','deleted_time'])
    def noncurrent(r): return any(k in r and r[k] is not None and not truth(r[k]) for k in ['is_current','current']) or truth(r.get('superseded_at'))
    def automated(r): return any(truth(r.get(k)) for k in ['is_automated','automated','is_agent','is_subagent','is_summary']) or str(value(r,['session_type','session_kind','kind','type']) or '').lower() in ['automated','automation','subagent','summary'] or str(r.get('relationship_type') or '').lower() == 'subagent'
    def time(r, session=False):
        v=value(r,['started_at','start_time','timestamp','time','created_at'] if session else ['timestamp','time','created_at'])
        return str(v) if v is not None else None
    def stamp(v):
        if v is None: return None
        try:
            d=datetime.datetime.fromisoformat(str(v).replace('Z','+00:00'))
            return (d if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)).timestamp()
        except (ValueError,TypeError): return None
    cutoff=stamp(sys.argv[2]) if len(sys.argv)>2 and sys.argv[2] else None
    def within(t): return cutoff is None or (stamp(t) is not None and stamp(t)<=cutoff)
    all_sessions={str(value(r,['id','session_id','conversation_id'])):r for r in ss}
    def ancestor_ids(r):
        keys=['root_id','root_session_id','parent_session_id','parent_id']
        pending=[str(r[k]) for k in keys if r.get(k) not in (None,'')]
        seen=set()
        while pending:
            parent=pending.pop()
            if parent in seen: continue
            seen.add(parent)
            record=all_sessions.get(parent,{})
            pending.extend(str(record[k]) for k in keys if record.get(k) not in (None,''))
        return sorted(seen)
    out,byid=[],{}
    for r in ss:
        if deleted(r) or noncurrent(r) or automated(r) or not within(time(r,True)): continue
        sid=value(r,['id','session_id','conversation_id'])
        if sid is None: raise ValueError()
        uid=value(r,['source_uuid','session_uuid','uuid','external_id','source_session_id'])
        rid=value(r,['root_id','root_session_id','parent_session_id','parent_id'])
        related=ancestor_ids(r)
        s=dict(id=str(sid),sourceUuid=str(uid) if uid is not None else None,rootId=str(rid) if rid is not None else None,relatedIds=related,time=time(r,True),project=value(r,['project']),machine=value(r,['machine']),sourceRevision=str(value(r,['transcript_revision','source_version'])) if value(r,['transcript_revision','source_version']) is not None else None,sourceSessionId=value(r,['source_session_id']),messages=[],fingerprint='',groupId='',selectionReasons=[])
        out.append(s);byid[str(sid)]=s
    def order(pair):
        index,r=pair; position=value(r,['sequence','seq','position','message_index','ordinal','index'])
        try: return (str(value(r,['session_id','conversation_id','session'])),0,float(position))
        except (ValueError,TypeError): return (str(value(r,['session_id','conversation_id','session'])),1,index)
    for _,r in sorted(enumerate(mm),key=order):
        if deleted(r) or noncurrent(r) or automated(r) or not within(time(r)): continue
        sid=value(r,['session_id','conversation_id','session'])
        if str(sid) not in byid: continue
        role=str(value(r,['role','speaker','type']) or '').lower()
        if role not in ['user','assistant','system']: continue
        is_system=truth(r.get('is_system')) or (role=='user' and truth(r.get('is_sidechain')))
        if is_system: role='system'
        mid=value(r,['id','message_id','uuid']);text=next((r[n] for n in ['text','content','body','message'] if n in r and r[n] is not None),None)
        if mid is None or not isinstance(text,str): raise ValueError()
        ordinal=value(r,['ordinal','sequence','seq','position','message_index','index'])
        byid[str(sid)]['messages'].append(dict(id=str(mid),role=role,text=text,time=time(r),sourceUuid=value(r,['source_uuid','uuid']),ordinal=ordinal,isSystem=is_system,isSidechain=truth(r.get('is_sidechain'))))
    db.rollback();db.close()
    print(json.dumps(out,ensure_ascii=False))
try: run()
except Exception:
    print('AV read adapter failed',file=sys.stderr);sys.exit(1)
`;

async function readSessions(db: string, before?: string): Promise<RawSession[]> {
  return new Promise((accept, reject) => {
    const child = spawn("python3", ["-c", reader, db, before ?? ""], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.resume();
    child.on("error", () => reject(new Error("AV read adapter unavailable")));
    child.on("close", (code) => {
      if (code !== 0)
        return reject(
          new Error("AV read adapter failed (unsupported schema or unavailable source)"),
        );
      try {
        accept(JSON.parse(Buffer.concat(chunks).toString("utf8")) as RawSession[]);
      } catch {
        reject(new Error("AV read adapter returned invalid data"));
      }
    });
  });
}

export async function freeze(options: {
  db: string;
  out: string;
  sessions: number;
  holdout: number;
  seed: string;
  repoRoot: string;
  before?: string;
  all?: boolean;
  preserveHoldoutIds?: string[];
}): Promise<FreezeManifest> {
  if (!isAbsolute(options.db) || !isAbsolute(options.out))
    throw new Error("Freeze source and destination must be absolute paths");
  if (
    options.before &&
    (!/[zZ]|[+-]\d{2}:\d{2}$/.test(options.before) || !Number.isFinite(Date.parse(options.before)))
  )
    throw new Error("Freeze cutoff must be an ISO timestamp with timezone");
  const repo = await realpath(options.repoRoot);
  const output = resolve(options.out);
  // Resolve the existing parent to detect symlinks into the repository.
  let ancestor = dirname(output);
  const suffix: string[] = [];
  while (true) {
    try {
      ancestor = await realpath(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error("Freeze destination unavailable");
      suffix.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }
  const actual = resolve(ancestor, ...suffix, relative(dirname(output), output));
  const rel = relative(repo, actual);
  if (!rel || (!rel.startsWith(".." + "/") && rel !== ".." && !isAbsolute(rel)))
    throw new Error("Freeze destination must be outside the repository");
  const input = await readSessions(options.db, options.before);
  const requested = options.all
    ? input.filter((session) =>
        session.messages.some((message) => message.role === "user" && message.text.trim()),
      ).length
    : options.sessions;
  if (options.all && options.holdout !== 0)
    throw new Error("Full freeze uses explicit preserved holdout IDs");
  const selected = selectSessions(input, requested, options.holdout, options.seed);
  if (options.preserveHoldoutIds?.length) {
    const old = new Set(options.preserveHoldoutIds);
    const groups = new Set(
      selected.sessions.filter((session) => old.has(session.id)).map((session) => session.groupId),
    );
    for (const session of selected.sessions)
      if (groups.has(session.groupId)) session.split = "holdout";
  }
  const sourceFingerprint = digest(
    [...input]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => ({ ...s, fingerprint: digest(s.messages) })),
  );
  const manifest: FreezeManifest = {
    format: "findme-av-dogfood-v0.1",
    id: digest([
      sourceFingerprint,
      options.seed,
      requested,
      options.holdout,
      options.preserveHoldoutIds ?? [],
    ]),
    createdAt: new Date().toISOString(),
    sourceFingerprint,
    seed: options.seed,
    requestedSessions: requested,
    requestedHoldout: options.holdout,
    cutoffBefore: options.before ?? null,
    samplingVersion: "av-sampling@4",
    sessions: selected.sessions,
    independence: "unknown",
    holdoutValidation: "pending",
    sampling: {
      availableSessions: selected.availableSessions,
      shortage: selected.shortage,
      holdoutShortage: selected.holdoutShortage,
    },
  };
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  try {
    await mkdir(output, { mode: 0o700 });
  } catch {
    throw new Error("Freeze destination already exists or is unavailable");
  }
  try {
    await writeFile(resolve(output, "raw.json"), `${JSON.stringify(selected.raw, null, 2)}\n`, {
      flag: "wx",
      mode: 0o400,
    });
    await writeFile(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o400,
    });
  } catch {
    throw new Error("Freeze write failed; destination reserved and must not be reused");
  }
  return manifest;
}

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freeze, selectSessions } from "../src/dogfood/freeze.js";
import type { RawSession } from "../src/dogfood/freeze.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const session = (id: string, text: string, extra: Partial<RawSession> = {}): RawSession => ({
  id,
  sourceUuid: null,
  rootId: null,
  time: null,
  messages: [{ id: `${id}-user`, role: "user", text, time: null }],
  fingerprint: "",
  groupId: "",
  selectionReasons: [],
  ...extra,
});

describe("AV deterministic sampling", () => {
  it("preserves complete text and covers short, long, project and correction sessions", () => {
    const input = [
      session("long", `转发\n${"很长的第三方内容".repeat(1000)}`),
      session("short", "嗯"),
      session("project", "项目约束及方案"),
      session("correction", "你说的不对，改成这个"),
    ];
    const first = selectSessions(input, 4, 0, "seed");
    expect(first.raw).toHaveLength(4);
    expect(first.raw.find((s) => s.id === "long")?.messages[0]?.text).toBe(
      input[0]?.messages[0]?.text,
    );
    expect(first.raw.flatMap((s) => s.selectionReasons)).toEqual(
      expect.arrayContaining([
        "long-paste",
        "short-judgment",
        "project-constraints",
        "corrections",
      ]),
    );
    expect(selectSessions([...input].reverse(), 4, 0, "seed")).toEqual(first);
    expect(input.every((s) => s.groupId === "")).toBe(true);
  });
  it("keeps transitive root, UUID and repeated user bodies in one split", () => {
    const duplicate = `项目中的同一段具体事实材料包含原始选择、上下文约束、目标、不同参与方和结果。${"This is an informative verbatim copied source with enough distinct content to conservatively associate the records, rather than a generic acknowledgement. ".repeat(2)}`;
    const input = [
      session("a", duplicate, { sourceUuid: "u" }),
      session("b", "second", { sourceUuid: "u" }),
      session("c", "third", { rootId: "b" }),
      session("d", duplicate),
      session("e", "unique"),
      session("f", "other"),
    ];
    const result = selectSessions(input, 6, 2, "seed");
    expect(result.shortage).toBe(0);
    const linked = result.sessions.filter((s) => ["a", "b", "c", "d"].includes(s.id));
    expect(new Set(linked.map((s) => s.groupId)).size).toBe(1);
    expect(new Set(linked.map((s) => s.split))).toEqual(new Set(["dev"]));
  });
  it("does not merge independent sessions through generic short acknowledgements", () => {
    const input = ["a", "b"].map((id) =>
      session(id, "可以", {
        messages: [
          { id: `${id}-ack`, role: "user", text: "可以", time: null },
          { id: `${id}-event`, role: "user", text: `具体独立经历 ${id}`, time: null },
        ],
      }),
    );
    const result = selectSessions(input, 2, 1, "short-ack");
    expect(result.sessions).toHaveLength(2);
    expect(new Set(result.sessions.map((s) => s.groupId)).size).toBe(2);
    expect(result.shortage).toBe(0);
  });
  it("keeps stable per-message source identity in the same split", () => {
    const input = ["a", "b"].map((id) =>
      session(id, `message ${id}`, {
        messages: [
          { id, role: "user", text: `message ${id}`, time: null, sourceUuid: "original-message" },
        ],
      }),
    );
    expect(
      new Set(selectSessions(input, 2, 0, "source-id").sessions.map((s) => s.groupId)).size,
    ).toBe(1);
  });
  it("retains known ancestry through a non-human bridge before splitting", () => {
    const input = [
      session("a", "independent wording a", { rootId: "bridge" }),
      session("bridge", "", {
        rootId: "root",
        messages: [{ id: "bridge-only", role: "assistant", text: "agent context", time: null }],
      }),
      session("b", "independent wording b", { rootId: "root" }),
    ];
    const combined = selectSessions(input, 2, 0, "bridge");
    expect(combined.sessions).toHaveLength(2);
    expect(new Set(combined.sessions.map((s) => s.groupId)).size).toBe(1);
    expect(selectSessions(input, 2, 1, "bridge").sessions).toHaveLength(0);
  });
  it("reports insufficient and indivisible groups without oversampling", () => {
    expect(selectSessions([session("a", "a")], 24, 6, "seed").shortage).toBe(23);
    const result = selectSessions(
      [session("a", "a", { rootId: "root" }), session("b", "b", { rootId: "root" })],
      2,
      1,
      "seed",
    );
    expect(result.sessions).toHaveLength(0);
    expect(result.holdoutShortage).toBe(1);
    expect(() => selectSessions([], 1, 2, "seed")).toThrow("Invalid");
  });
  it("retains simultaneous root and parent relationships", () => {
    const result = selectSessions(
      [
        session("root", "r"),
        session("parent", "p"),
        session("child", "c", { rootId: "root", relatedIds: ["root", "parent"] }),
      ],
      3,
      0,
      "seed",
    );
    expect(new Set(result.sessions.map((s) => s.groupId)).size).toBe(1);
    expect(result.sessions.find((s) => s.id === "child")?.relatedIds).toEqual(["parent", "root"]);
  });
});

describe("AV readonly freeze", () => {
  async function fixture() {
    const folder = await mkdtemp(resolve(tmpdir(), "findme-freeze-test-"));
    temporary.push(folder);
    const db = resolve(folder, "av.sqlite");
    execFileSync("python3", [
      "-c",
      `
import sqlite3, sys
d=sqlite3.connect(sys.argv[1])
d.executescript('CREATE TABLE sessions(id TEXT, source_uuid TEXT, parent_session_id TEXT, created_at TEXT, is_automated INTEGER, deleted_at TEXT); CREATE TABLE messages(id TEXT, session_id TEXT, role TEXT, content TEXT, timestamp TEXT, is_deleted INTEGER);')
d.executemany('INSERT INTO sessions VALUES(?,?,?,?,?,?)', [('human','source',None,'2026',0,None),('robot',None,None,None,1,None),('deleted',None,None,None,0,'2026'),('empty',None,None,None,0,None)])
d.executemany('INSERT INTO messages VALUES(?,?,?,?,?,?)', [('m1','human','user','本人要求'+('全文'*5000),'2026',0),('m2','human','assistant','AI 引用上下文',None,0),('m3','human','user','已删除',None,1),('m4','robot','user','automated',None,0),('m5','deleted','user','deleted',None,0),('m6','empty','assistant','no human',None,0)])
d.commit();d.close()
`,
      db,
    ]);
    return { folder, db };
  }
  it("reads actual user messages, excludes automated/deleted sessions, freezes without modifying source", async () => {
    const { folder, db } = await fixture();
    const before = await readFile(db);
    const out = resolve(folder, "batch");
    const manifest = await freeze({
      db,
      out,
      sessions: 24,
      holdout: 6,
      seed: "fixed",
      repoRoot: process.cwd(),
    });
    expect(manifest.sessions.map((s) => s.id)).toEqual(["human"]);
    expect(manifest.sampling?.shortage).toBe(23);
    expect(manifest.independence).toBe("unknown");
    expect(manifest.holdoutValidation).toBe("pending");
    const raw = JSON.parse(await readFile(resolve(out, "raw.json"), "utf8")) as RawSession[];
    expect(raw[0]?.messages).toHaveLength(2);
    expect(raw[0]?.messages[0]?.text.length).toBeGreaterThan(10000);
    expect(raw[0]?.messages[1]?.text).toBe("AI 引用上下文");
    expect(await readFile(db)).toEqual(before);
    expect((await stat(out)).mode & 0o777).toBe(0o700);
    expect((await stat(resolve(out, "raw.json"))).mode & 0o777).toBe(0o400);
    expect((await stat(resolve(out, "manifest.json"))).mode & 0o777).toBe(0o400);
    await expect(
      freeze({ db, out, sessions: 24, holdout: 6, seed: "fixed", repoRoot: process.cwd() }),
    ).rejects.toThrow("already exists");
    expect(await readFile(db)).toEqual(before);
  });
  it("rejects repository destinations including symlinked parents", async () => {
    const { folder, db } = await fixture();
    const repo = resolve(folder, "repository");
    execFileSync("python3", ["-c", "import os,sys;os.mkdir(sys.argv[1])", repo]);
    await symlink(repo, resolve(folder, "link"));
    for (const out of [resolve(repo, "nested", "batch"), resolve(folder, "link", "batch")]) {
      await expect(
        freeze({ db, out, sessions: 1, holdout: 0, seed: "fixed", repoRoot: repo }),
      ).rejects.toThrow("outside");
    }
  });
  it("sanitizes source errors", async () => {
    const { folder } = await fixture();
    await expect(
      freeze({
        db: resolve(folder, "private-body-missing"),
        out: resolve(folder, "batch"),
        sessions: 1,
        holdout: 0,
        seed: "fixed",
        repoRoot: process.cwd(),
      }),
    ).rejects.toThrow(/^AV read adapter failed \(unsupported schema or unavailable source\)$/);
  });
  it("rejects relative source or destination paths at the public API", async () => {
    const { folder, db } = await fixture();
    for (const options of [
      { db: "relative.sqlite", out: resolve(folder, "batch") },
      { db, out: "batch" },
    ]) {
      await expect(
        freeze({ ...options, sessions: 1, holdout: 0, seed: "seed", repoRoot: process.cwd() }),
      ).rejects.toThrow("absolute");
    }
  });
  it("rejects unsupported schemas even when both tables are empty", async () => {
    const { folder } = await fixture();
    const db = resolve(folder, "unsupported.sqlite");
    execFileSync("python3", [
      "-c",
      "import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.executescript('CREATE TABLE sessions(id TEXT); CREATE TABLE messages(id TEXT, session_id TEXT, role TEXT);');d.close()",
      db,
    ]);
    await expect(
      freeze({
        db,
        out: resolve(folder, "batch"),
        sessions: 1,
        holdout: 0,
        seed: "seed",
        repoRoot: process.cwd(),
      }),
    ).rejects.toThrow("unsupported schema");
  });
  it("excludes noncurrent and automated messages while preserving archived current history", async () => {
    const { folder, db } = await fixture();
    execFileSync("python3", [
      "-c",
      `
import sqlite3,sys
d=sqlite3.connect(sys.argv[1])
d.executescript('ALTER TABLE sessions ADD COLUMN is_current INTEGER; ALTER TABLE sessions ADD COLUMN current INTEGER; ALTER TABLE sessions ADD COLUMN superseded_at TEXT; ALTER TABLE sessions ADD COLUMN archived INTEGER; ALTER TABLE sessions ADD COLUMN root_session_id TEXT; ALTER TABLE messages ADD COLUMN is_automated INTEGER;')
d.execute("UPDATE sessions SET archived=1, root_session_id='root', parent_session_id='parent' WHERE id='human'")
d.executemany('INSERT INTO sessions(id,is_current,current,superseded_at) VALUES(?,?,?,?)', [('old1',0,None,None),('old2',None,0,None),('old3',None,None,'2026'),('machine-only',1,1,None)])
d.executemany('INSERT INTO messages(id,session_id,role,content,is_automated) VALUES(?,?,?,?,?)', [('old1-msg','old1','user','old1',0),('old2-msg','old2','user','old2',0),('old3-msg','old3','user','old3',0),('machine-msg','machine-only','user','machine',1),('excluded','human','user','auto task',1)])
d.commit();d.close()
`,
      db,
    ]);
    const out = resolve(folder, "batch");
    const result = await freeze({
      db,
      out,
      sessions: 24,
      holdout: 6,
      seed: "seed",
      repoRoot: process.cwd(),
    });
    expect(result.sessions.map((s) => s.id)).toEqual(["human"]);
    expect(result.sessions[0]?.relatedIds).toEqual(["parent", "root"]);
    const raw = JSON.parse(await readFile(resolve(out, "raw.json"), "utf8")) as RawSession[];
    expect(raw[0]?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });
  it("honors cutoff, system roles and AV provenance without exporting hidden reasoning", async () => {
    const { folder, db } = await fixture();
    execFileSync("python3", [
      "-c",
      `
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.executescript('ALTER TABLE sessions ADD COLUMN started_at TEXT; ALTER TABLE sessions ADD COLUMN source_session_id TEXT; ALTER TABLE sessions ADD COLUMN transcript_revision TEXT; ALTER TABLE sessions ADD COLUMN project TEXT; ALTER TABLE sessions ADD COLUMN machine TEXT; ALTER TABLE messages ADD COLUMN is_system INTEGER; ALTER TABLE messages ADD COLUMN source_uuid TEXT; ALTER TABLE messages ADD COLUMN ordinal INTEGER; ALTER TABLE messages ADD COLUMN thinking_text TEXT;')
c.execute("UPDATE sessions SET started_at='2026-09-01T00:00:00Z', source_session_id='native-sid', transcript_revision='rev-2',project='sample',machine='mac' WHERE id='human'")
c.execute("UPDATE messages SET timestamp='2026-09-01T01:00:00Z',source_uuid='native-message',ordinal=7,thinking_text='HIDDEN_REASONING_NOT_EXPORTED' WHERE id='m1'")
c.execute("UPDATE messages SET timestamp='2026-09-01T02:00:00Z',ordinal=8 WHERE id='m2'")
c.execute("INSERT INTO messages(id,session_id,role,content,timestamp,is_system,ordinal) VALUES('wrapper','human','user','runtime wrapper','2026-09-01T03:00:00Z',1,9)")
c.execute("INSERT INTO messages(id,session_id,role,content,timestamp,ordinal) VALUES('future','human','user','future generated prompt','2026-10-03T01:00:00Z',10)")
c.commit();c.close()
`,
      db,
    ]);
    const out = resolve(folder, "cutoff-batch");
    const manifest = await freeze({
      db,
      out,
      sessions: 1,
      holdout: 0,
      seed: "cutoff",
      before: "2026-10-02T00:00:00Z",
      repoRoot: process.cwd(),
    });
    const rawText = await readFile(resolve(out, "raw.json"), "utf8");
    const raw = JSON.parse(rawText) as RawSession[];
    expect(rawText).not.toContain("HIDDEN_REASONING_NOT_EXPORTED");
    expect(rawText).not.toContain("future generated prompt");
    expect(raw[0]?.sourceRevision).toBe("rev-2");
    expect(raw[0]?.sourceSessionId).toBe("native-sid");
    expect(raw[0]?.project).toBe("sample");
    expect(raw[0]?.messages.find((m) => m.id === "wrapper")?.role).toBe("system");
    expect(raw[0]?.messages.find((m) => m.id === "m1")?.sourceUuid).toBe("native-message");
    expect(raw[0]?.messages.find((m) => m.id === "m1")?.ordinal).toBe(7);
    expect(manifest.cutoffBefore).toBe("2026-10-02T00:00:00Z");
    await expect(
      freeze({
        db,
        out: resolve(folder, "invalid-date"),
        sessions: 1,
        holdout: 0,
        seed: "cutoff",
        before: "invalid",
        repoRoot: process.cwd(),
      }),
    ).rejects.toThrow("ISO timestamp");
  });
  it("excludes explicit subagents even when AV automated flag is false", async () => {
    const { folder, db } = await fixture();
    execFileSync("python3", [
      "-c",
      `
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.executescript('ALTER TABLE sessions ADD COLUMN relationship_type TEXT; ALTER TABLE sessions ADD COLUMN session_kind TEXT; ALTER TABLE messages ADD COLUMN is_sidechain INTEGER;')
c.execute("INSERT INTO sessions(id,is_automated,relationship_type) VALUES('agent-child',0,'subagent')")
c.execute("INSERT INTO messages(id,session_id,role,content) VALUES('task','agent-child','user','machine issued task')")
c.execute("INSERT INTO messages(id,session_id,role,content,is_sidechain) VALUES('side-task','human','user','sidechain task',1)")
c.commit();c.close()
`,
      db,
    ]);
    const out = resolve(folder, "subagent-batch");
    const manifest = await freeze({
      db,
      out,
      sessions: 24,
      holdout: 6,
      seed: "subagent",
      repoRoot: process.cwd(),
    });
    expect(manifest.sessions.map((s) => s.id)).toEqual(["human"]);
    const raw = JSON.parse(await readFile(resolve(out, "raw.json"), "utf8")) as RawSession[];
    expect(raw[0]?.messages.find((m) => m.id === "side-task")?.role).toBe("system");
  });
});

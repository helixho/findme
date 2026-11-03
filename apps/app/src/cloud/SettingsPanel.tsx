import { useEffect, useState } from "react";
import { cloudMutation, cloudRequest } from "../cloud-api";
import { message } from "./shared";

type ModelSettings = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  profileCallLimit: number;
  jobCallLimit: number;
  coreDailyOperationLimit: number;
  frameworkCallLimit: number;
  apiKeyConfigured: boolean;
};

const limits = [
  ["coreDailyOperationLimit", "对话自动处理（每 24 小时次数）"],
  ["profileCallLimit", "诊断调用总额度"],
  ["jobCallLimit", "单个任务最多调用次数"],
  ["frameworkCallLimit", "框架访谈调用额度"],
] as const;

/** Instance-wide model provider settings; the key is write-only. */
export function SettingsPanel() {
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    cloudRequest<ModelSettings>("/api/settings/model", {}, false)
      .then(setSettings)
      .catch((e) => setNotice(message(e)));
  }, []);
  if (!settings) return <p className="cloud-muted">{notice || "正在读取设置…"}</p>;
  const set = <K extends keyof ModelSettings>(key: K, value: ModelSettings[K]) =>
    setSettings({ ...settings, [key]: value });
  async function save() {
    if (!settings) return;
    setBusy(true);
    setNotice("");
    try {
      const { apiKeyConfigured: _, ...values } = settings;
      const saved = await cloudMutation<ModelSettings>(
        "/api/settings/model",
        apiKey ? { ...values, apiKey } : values,
        "PUT",
        false,
      );
      setSettings(saved);
      setApiKey("");
      setNotice("已保存，立即生效。");
    } catch (e) {
      setNotice(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="home-section">
      <h3>模型设置</h3>
      <p className="cloud-muted">
        兼容 OpenAI 接口的模型服务。设置保存在本实例的数据库中，随数据一起迁移。
      </p>
      <label>
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => set("enabled", e.target.checked)}
        />{" "}
        启用模型调用
      </label>
      <label>
        接口地址
        <input value={settings.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} />
      </label>
      <label>
        模型名称
        <input value={settings.model} onChange={(e) => set("model", e.target.value)} />
      </label>
      <label>
        API Key{settings.apiKeyConfigured ? "（已保存，留空则不变）" : "（未设置）"}
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      {limits.map(([key, title]) => (
        <label key={key}>
          {title}
          <input
            type="number"
            min={0}
            value={settings[key]}
            onChange={(e) => set(key, Number(e.target.value))}
          />
        </label>
      ))}
      <button type="button" disabled={busy} onClick={() => void save()}>
        保存设置
      </button>
      {notice && <output>{notice}</output>}
    </section>
  );
}

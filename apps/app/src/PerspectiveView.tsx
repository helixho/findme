import { useEffect, useState } from "react";
import { CloudApiError, cloudMutation, cloudRequest } from "./cloud-api";

type Content = {
  content_id: string;
  version: string;
  title: string;
  summary: string;
  claims: { id: string; text: string }[];
};
type Reflection = {
  situation: string;
  claim: string;
  evidence: {
    source_title: string;
    source_url: string;
    locator: string;
    fragment: string;
    attribution: string;
  }[];
  alternative_explanations: string[];
  reflection_prompts: string[];
  limits: string[];
  user_response: string | null;
  response_persisted: false;
};

function message(error: unknown) {
  return error instanceof CloudApiError
    ? error.code
    : error instanceof Error
      ? error.message
      : "读取失败";
}

export function PerspectiveView() {
  const [card, setCard] = useState<Content | null>(null);
  const [situation, setSituation] = useState("");
  const [response, setResponse] = useState("");
  const [reflection, setReflection] = useState<Reflection | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void cloudRequest<{ items: Content[] }>("/api/content")
      .then(({ items }) =>
        setCard(items.find((item) => item.content_id === "perspective.a-new-earth") ?? null),
      )
      .catch((e) => setError(message(e)));
  }, []);

  async function show() {
    if (!card || !situation.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await cloudMutation<{ perspective: Reflection }>(
        "/api/content/perspectives/a-new-earth/reflection",
        { enabled: true, situation, claim_id: card.claims[0].id, response },
      );
      setReflection(result.perspective);
      setEnabled(true);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="perspective-view">
      <h1>借一本书看一件事</h1>
      <p>
        作品提供一个可比较的提问角度。关于你发生了什么，仍以你的经历为准；关掉视角不会改写事实。
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!card && (
        <p>《新世界》（A New Earth）的内容卡尚未发布。目前不能用它给具体处境生成作品视角。</p>
      )}
      {card && (
        <section className="home-section">
          <h2>{card.title}</h2>
          <p>{card.summary}</p>
          <label>
            选一件具体的事
            <textarea rows={4} value={situation} onChange={(e) => setSituation(e.target.value)} />
          </label>
          <label>
            你的看法或异议（可留空）
            <textarea rows={3} value={response} onChange={(e) => setResponse(e.target.value)} />
          </label>
          <div className="cloud-actions">
            <button
              type="button"
              className="button primary"
              disabled={busy || !situation.trim()}
              onClick={() => void show()}
            >
              显示这个视角
            </button>
            <button
              type="button"
              disabled={!enabled}
              onClick={() => {
                setEnabled(false);
                setReflection(null);
              }}
            >
              关闭视角
            </button>
          </div>
          {enabled && reflection && (
            <article>
              <h3>作品视角中的一个问题</h3>
              <p>{reflection.claim}</p>
              <details>
                <summary>作品定位与来源</summary>
                {reflection.evidence.map((item) => (
                  <p key={`${item.source_url}:${item.locator}`}>
                    <a href={item.source_url} target="_blank" rel="noreferrer">
                      {item.source_title}
                    </a>{" "}
                    · {item.locator}
                    <br />
                    {item.fragment}
                    <small>{item.attribution}</small>
                  </p>
                ))}
              </details>
              <h3>也可能这样理解</h3>
              <ul>
                {reflection.alternative_explanations.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <h3>你可以自己判断</h3>
              <ul>
                {reflection.reflection_prompts.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              {reflection.user_response && <p>你的回应：{reflection.user_response}</p>}
              <details>
                <summary>这个视角的限制</summary>
                <ul>
                  {reflection.limits.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </details>
              <small>
                本次回应尚未保存到个人资料；如果要长期保留，可把它作为自己的新经历或想法另行记录。
              </small>
            </article>
          )}
        </section>
      )}
    </section>
  );
}

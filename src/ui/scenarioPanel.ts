import {
  decodeScenario,
  encodeScenario,
  MAX_LINK_LENGTH,
  MAX_SCENARIO_BYTES,
  parseJson,
  readHash,
  scenarioKey,
} from '../scenario/codec';
import { parseScenario, type Scenario, type ScenarioQuestion } from '../scenario/schema';
import { type CaptureOptions, checkAnswer, parseQuestionLines, questionLines } from '../scenario/setup';
import { CollapsiblePanel } from './collapsiblePanel';
import { downloadBlob, safeFileName } from './download';
import { embedUrl, iframeCode } from './embed';
import * as kit from './panelKit';

/** An entry of public/scenarios/index.json. */
interface LibraryEntry {
  id: string;
  title: string;
  topic?: string;
}

const STORAGE_PREFIX = 'langevin-dynamics:answers:';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * The Scenario window: opens scenarios (the course scenarios, links, files, Gists), shows the
 * loaded one's text and worksheet, and creates new ones from the current set-up.
 *
 * Answers are kept in this browser (localStorage, per scenario) and can be downloaded as a JSON
 * file; numeric answers can be checked against a given value or a value the app measures. All
 * text from a scenario is shown as text (formulas between $…$ typeset by KaTeX), never as HTML.
 */
export class ScenarioPanel {
  private readonly panel: CollapsiblePanel;
  private readonly value: HTMLOutputElement;
  private readonly current: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly descEl: HTMLElement;
  private readonly questionsEl: HTMLOListElement;
  private readonly libraryEl: HTMLElement;
  private readonly share: {
    title: HTMLInputElement;
    description: HTMLTextAreaElement;
    questions: HTMLTextAreaElement;
    particles: HTMLInputElement;
    potential: HTMLInputElement;
    play: HTMLInputElement;
    link: HTMLInputElement;
    message: HTMLElement;
    details: HTMLDetailsElement;
  };
  private readonly fileInput: HTMLInputElement;
  private scenario: Scenario | null = null;
  private key = '';
  private answers: string[] = [];
  private libraryLoaded = false;
  private katex: typeof import('./helpMath') | null = null;

  constructor(
    private readonly actions: {
      /** Sets the app up as the scenario says (throws with a message if it cannot). */
      apply(s: Scenario): void;
      capture(o: CaptureOptions): Scenario;
      readouts(): Record<string, number>;
      toast(text: string): void;
      /** The window was opened (e.g. to fold other windows away on small screens). */
      opened?(): void;
    },
  ) {
    // At the top right, apart from the analysis windows on the left.
    const parts = kit.createPanel({ id: 'scenario', title: 'Scenario', label: 'Scenario', before: 'right-bottom', column: '.right-col' });
    this.value = parts.value;
    const body = parts.body;

    // The loaded scenario and its worksheet.
    this.current = el('div', 'sc-current');
    this.current.hidden = true;
    this.titleEl = el('div', 'sc-title');
    this.descEl = el('div', 'sc-desc');
    this.questionsEl = el('ol', 'sc-questions');
    this.current.append(this.titleEl, this.descEl, this.questionsEl);
    body.append(this.current);
    const [restart, saveAnswers] = kit.buttons(this.current, ['Restart scenario', 'Download answers']);
    restart.addEventListener('click', () => this.scenario && this.load(this.scenario));
    saveAnswers.addEventListener('click', () => this.downloadAnswers());

    // Course scenarios.
    kit.caption(body, 'Course scenarios');
    this.libraryEl = el('div', 'sc-library');
    body.append(this.libraryEl);

    // Create and share.
    const details = el('details', 'sc-share');
    details.append(el('summary', undefined, 'Create & share a scenario'));
    const field = (label: string, input: HTMLElement) => {
      const row = el('label', 'field sc-field');
      row.append(el('span', 'field-head', label), input);
      details.append(row);
    };
    const title = el('input');
    title.type = 'text';
    title.maxLength = 120;
    title.placeholder = 'Title';
    const description = el('textarea');
    description.rows = 3;
    description.maxLength = 6000;
    description.placeholder = 'What to do and look for ($…$ for formulas)';
    const questions = el('textarea');
    questions.rows = 4;
    questions.placeholder = 'One question per line. Optional check:\nWhat is the variance? = 0.25 ± 0.02\nMean exit time? = @firstPassage.meanTau ± 10%';
    field('Title', title);
    field('Description', description);
    field('Questions', questions);
    const check = (label: string, checked: boolean) => {
      const row = el('label', 'switch-row');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = checked;
      row.append(box, el('span', 'switch'), el('span', undefined, label));
      details.append(row);
      return box;
    };
    const particles = check('Include the particles', true);
    const potential = check('Include the painted Ψ (can be large)', false);
    const play = check('Start playing when opened', false);
    const [copy, embed] = kit.buttons(details, ['Copy link', 'Copy embed code']);
    const [download] = kit.buttons(details, ['Download .json']);
    const link = el('input', 'sc-link');
    link.type = 'text';
    link.readOnly = true;
    link.hidden = true;
    link.setAttribute('aria-label', 'Scenario link');
    details.append(link);
    const message = kit.info(details);
    this.share = { title, description, questions, particles, potential, play, link, message, details };
    copy.addEventListener('click', () => void this.copyLink('link'));
    embed.addEventListener('click', () => void this.copyLink('embed'));
    download.addEventListener('click', () => this.downloadScenario());

    // Opening from a file or a Gist.
    const [open] = kit.buttons(body, ['Open scenario file (.json)…']);
    this.fileInput = el('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.json,application/json';
    this.fileInput.hidden = true;
    body.append(this.fileInput);
    open.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (file) void this.openFile(file);
    });
    const gistRow = el('div', 'sc-gist');
    const gist = el('input');
    gist.type = 'text';
    gist.placeholder = 'GitHub Gist id or link';
    gist.setAttribute('aria-label', 'GitHub Gist id or link');
    const gistBtn = el('button', 'ghost-btn', 'Open Gist');
    gistBtn.type = 'button';
    gistRow.append(gist, gistBtn);
    body.append(gistRow);
    gistBtn.addEventListener('click', () => {
      const id = /([0-9a-f]{20,40})\/?$/i.exec(gist.value.trim())?.[1];
      if (!id) this.actions.toast('Enter the id of a public Gist (the hex code at the end of its link).');
      else location.hash = `gist=${id}`;
    });
    body.append(details);

    this.panel = new CollapsiblePanel(parts.ids, (open) => {
      if (open) {
        void this.loadLibrary();
        this.loadMath();
        this.actions.opened?.();
      }
    });
    this.panel.setOpen(false);
    window.addEventListener('hashchange', () => void this.loadFromHash());
  }

  setOpen(open: boolean): void {
    this.panel.setOpen(open);
  }

  /** Opens the share section (e.g. from the Scene menu). */
  openShare(): void {
    this.panel.setOpen(true);
    this.share.details.open = true;
    this.share.title.focus();
  }

  /** Loads the scenario the URL hash names, if any. */
  async loadFromHash(): Promise<void> {
    const req = readHash(location.hash);
    if (!req) return;
    try {
      let raw: unknown;
      if (req.kind === 'link') raw = decodeScenario(req.data);
      else if (req.kind === 'builtin') raw = await fetchJson(`${import.meta.env.BASE_URL}scenarios/${req.name}.json`);
      else raw = await fetchGist(req.id);
      this.open(raw, true);
    } catch (err) {
      console.error(err);
      this.actions.toast(err instanceof Error ? err.message : 'The scenario could not be loaded.');
    }
  }

  /**
   * Validates and loads an untrusted scenario. One that did not come from the address drops a
   * scenario hash from it, so reloading the page does not bring back the previous scenario.
   */
  open(raw: unknown, fromHash = false): void {
    const r = parseScenario(raw);
    if (!r.ok) {
      this.actions.toast(r.message);
      return;
    }
    if (!fromHash && readHash(location.hash)) history.replaceState(null, '', location.pathname + location.search);
    this.load(r.scenario);
  }

  private load(s: Scenario): void {
    try {
      this.actions.apply(s);
    } catch (err) {
      console.error(err);
      this.actions.toast(err instanceof Error ? err.message : 'The scenario could not be applied.');
      return;
    }
    this.scenario = s;
    this.key = scenarioKey(s);
    this.answers = this.loadAnswers(s.questions?.length ?? 0);
    this.render();
    this.panel.setOpen(true);
    // The share form starts from the loaded scenario, so it can be adapted and shared again.
    this.share.title.value = s.title;
    this.share.description.value = s.description ?? '';
    this.share.questions.value = questionLines(s.questions ?? []);
    this.share.play.checked = s.play ?? false;
    this.actions.toast(`Scenario: ${s.title}`);
  }

  private render(): void {
    const s = this.scenario;
    this.current.hidden = !s;
    this.value.textContent = s ? (s.questions?.length ? `${this.answeredCount()}/${s.questions.length}` : 'loaded') : '';
    if (!s) return;
    this.titleEl.textContent = s.title;
    this.setText(this.descEl, s.description ?? '');
    this.questionsEl.replaceChildren();
    (s.questions ?? []).forEach((q, i) => this.questionsEl.append(this.questionItem(q, i)));
  }

  private questionItem(q: ScenarioQuestion, i: number): HTMLLIElement {
    const li = el('li', 'sc-question');
    const text = el('div', 'sc-qtext');
    this.setText(text, q.text);
    li.append(text);
    const row = el('div', 'sc-answer');
    let input: HTMLInputElement | HTMLSelectElement;
    if (q.kind === 'choice' && q.choices?.length) {
      const select = el('select');
      select.append(el('option', undefined, '—'));
      for (const c of q.choices) select.append(el('option', undefined, c));
      select.value = this.answers[i] || '—';
      input = select;
    } else {
      const field = el('input');
      field.type = 'text';
      field.inputMode = q.kind === 'number' ? 'decimal' : 'text';
      field.placeholder = q.kind === 'number' ? 'a number' : 'your answer';
      field.value = this.answers[i] ?? '';
      input = field;
    }
    input.setAttribute('aria-label', `Answer ${i + 1}`);
    const result = el('span', 'sc-result');
    const save = () => {
      this.answers[i] = input.value === '—' ? '' : input.value;
      this.saveAnswers();
      this.value.textContent = `${this.answeredCount()}/${this.scenario?.questions?.length ?? 0}`;
      result.textContent = '';
      result.className = 'sc-result';
    };
    input.addEventListener('change', save);
    input.addEventListener('input', save);
    row.append(input);
    const checkable = q.readout !== undefined || q.answer !== undefined;
    if (checkable) {
      const btn = el('button', 'ghost-btn', 'Check');
      btn.type = 'button';
      btn.addEventListener('click', () => {
        const ok = checkAnswer(q, this.answers[i] ?? '', this.actions.readouts());
        result.className = `sc-result ${ok === true ? 'ok' : ok === false ? 'wrong' : ''}`;
        result.textContent =
          ok === true
            ? '✓ correct'
            : ok === false
              ? '✗ not yet'
              : q.readout && (this.answers[i] ?? '').trim()
                ? 'the app has not measured this yet: open its window and run'
                : 'enter an answer';
      });
      row.append(btn);
    }
    li.append(row, result);
    return li;
  }

  private answeredCount(): number {
    return this.answers.filter((a) => a && a.trim()).length;
  }

  /** Text with $…$ formulas typeset (KaTeX); everything else as plain text. */
  private setText(target: HTMLElement, text: string): void {
    target.replaceChildren();
    const parts = text.split(/(\$[^$]+\$)/g);
    for (const part of parts) {
      if (/^\$[^$]+\$$/.test(part)) {
        const span = el('span', 'tex', part);
        span.dataset.tex = part.slice(1, -1);
        target.append(span);
      } else if (part) {
        // Line breaks of the source become real ones.
        part.split('\n').forEach((line, k) => {
          if (k > 0) target.append(el('br'));
          target.append(document.createTextNode(line));
        });
      }
    }
    if (this.katex) this.katex.renderMath(target, '.tex[data-tex]');
    else this.loadMath();
  }

  private loadMath(): void {
    import('./helpMath')
      .then((m) => {
        this.katex = m;
        m.renderMath(this.current, '.tex[data-tex]');
      })
      .catch((err) => console.error(err)); // the formulas stay as $…$ text
  }

  private async loadLibrary(): Promise<void> {
    if (this.libraryLoaded) return;
    this.libraryLoaded = true;
    try {
      const raw = await fetchJson(`${import.meta.env.BASE_URL}scenarios/index.json`);
      const entries = (Array.isArray(raw) ? raw : []).filter(
        (e): e is LibraryEntry =>
          !!e && typeof e === 'object' && typeof e.id === 'string' && /^[a-z0-9-]{1,60}$/.test(e.id) && typeof e.title === 'string',
      );
      for (const e of entries) {
        const b = el('button', 'sc-entry');
        b.type = 'button';
        b.append(el('span', 'sc-entry-title', e.title));
        if (typeof e.topic === 'string') b.append(el('span', 'sc-entry-topic', e.topic));
        b.addEventListener('click', () => {
          // Through the hash, so the address bar holds a link to this scenario.
          if (location.hash === `#scenario=${e.id}`) void this.loadFromHash();
          else location.hash = `scenario=${e.id}`;
        });
        this.libraryEl.append(b);
      }
    } catch (err) {
      console.error(err);
      this.libraryLoaded = false;
      this.libraryEl.textContent = 'The course scenarios could not be loaded.';
    }
  }

  private captureOptions(): CaptureOptions {
    const s = this.share;
    return {
      title: s.title.value,
      description: s.description.value,
      questions: parseQuestionLines(s.questions.value),
      includeParticles: s.particles.checked,
      includePotential: s.potential.checked,
      play: s.play.checked,
    };
  }

  /** Validated current scenario (what would be shared), or null with a message. */
  private captureChecked(): Scenario | null {
    const scenario = this.actions.capture(this.captureOptions());
    const r = parseScenario(scenario); // what others will load must pass the same checks
    if (!r.ok) {
      this.share.message.textContent = r.message;
      return null;
    }
    return r.scenario;
  }

  /**
   * Copies a link to the current set-up, or (`embed`) the HTML of an iframe that shows it in
   * another page (see embed.ts). Both carry the scenario in the address.
   */
  private async copyLink(kind: 'link' | 'embed'): Promise<void> {
    const s = this.captureChecked();
    if (!s) return;
    const hash = `#s=${encodeScenario(s)}`;
    const url = kind === 'embed' ? embedUrl(hash) : `${location.origin}${location.pathname}${hash}`;
    const text = kind === 'embed' ? iframeCode(url, `Langevin Dynamics: ${s.title}`) : url;
    const { link, message } = this.share;
    if (url.length > MAX_LINK_LENGTH) {
      link.hidden = true;
      message.textContent =
        `This scenario is too long for a link (${Math.round(url.length / 1000)} k characters). Download it as a file and send that, ` +
        'or upload the file as a public GitHub Gist and share this page with #gist=<its id> at the end. ' +
        'Leaving out the particles or the painted Ψ makes it shorter.';
      return;
    }
    link.hidden = false;
    link.value = text;
    try {
      await navigator.clipboard.writeText(text);
      message.textContent =
        kind === 'embed'
          ? 'Embed code copied. Paste it into a web page (HTML): the page then shows this set-up, with its questions.'
          : `Link copied (${url.length} characters). Anyone who opens it gets this set-up.`;
    } catch {
      link.select();
      message.textContent = `Copy the ${kind === 'embed' ? 'code' : 'link'} above (the clipboard is not available here).`;
    }
  }

  private downloadScenario(): void {
    const s = this.captureChecked();
    if (!s) return;
    const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `${safeFileName(s.title, 'scenario')}.json`);
    this.share.message.textContent = 'Saved. Open it with “Open scenario file”, or drop it on the page.';
  }

  /** Opens a scenario file (from the file picker or a drop). */
  async openFile(file: File): Promise<void> {
    if (file.size > MAX_SCENARIO_BYTES) {
      this.actions.toast('This file is too large for a scenario.');
      return;
    }
    try {
      this.open(parseJson(await file.text()));
    } catch (err) {
      this.actions.toast(err instanceof Error ? err.message : 'The file could not be read.');
    }
  }

  private downloadAnswers(): void {
    const s = this.scenario;
    if (!s) return;
    const readouts = this.actions.readouts();
    const data = {
      scenario: s.title,
      scenarioId: this.key,
      savedAt: new Date().toISOString(),
      answers: (s.questions ?? []).map((q, i) => {
        const answer = this.answers[i] ?? '';
        const ok = checkAnswer(q, answer, readouts);
        return { question: q.text, answer, check: ok === null ? 'not checked' : ok ? 'correct' : 'not correct' };
      }),
    };
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `answers-${safeFileName(s.title, 'scenario')}.json`);
  }

  private loadAnswers(n: number): string[] {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + this.key);
      const arr = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(arr)) return Array.from({ length: n }, (_, i) => (typeof arr[i] === 'string' ? arr[i].slice(0, 2000) : ''));
    } catch {
      // no storage (private mode) or damaged: start empty
    }
    return Array.from({ length: n }, () => '');
  }

  private saveAnswers(): void {
    try {
      localStorage.setItem(STORAGE_PREFIX + this.key, JSON.stringify(this.answers));
    } catch {
      // storage full or blocked: answers stay on the page and can still be downloaded
    }
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('The scenario could not be found.');
  const text = await res.text();
  if (text.length > MAX_SCENARIO_BYTES) throw new Error('The scenario is too large.');
  return parseJson(text);
}

/** The first JSON file of a public Gist (GitHub's API allows this from the browser). */
async function fetchGist(id: string): Promise<unknown> {
  const res = await fetch(`https://api.github.com/gists/${id}`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(res.status === 404 ? 'This Gist does not exist or is not public.' : 'The Gist could not be loaded.');
  const gist = (await res.json()) as { files?: Record<string, { filename?: string; content?: string; truncated?: boolean; raw_url?: string; size?: number }> };
  const files = Object.values(gist.files ?? {});
  const file = files.find((f) => f.filename?.toLowerCase().endsWith('.json')) ?? files[0];
  if (!file) throw new Error('The Gist has no files.');
  if ((file.size ?? 0) > MAX_SCENARIO_BYTES) throw new Error('The scenario is too large.');
  if (!file.truncated && typeof file.content === 'string') return parseJson(file.content);
  // Large files are truncated in the API answer; their raw text comes from GitHub's content host.
  const raw = file.raw_url ?? '';
  if (!/^https:\/\/gist\.githubusercontent\.com\//.test(raw)) throw new Error('The Gist could not be loaded.');
  return fetchJson(raw);
}

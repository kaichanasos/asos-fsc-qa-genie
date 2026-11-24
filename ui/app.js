// QA Genie web UI: plain DOM, no build step. The API is in src/server.ts.

const $ = (selector) => document.querySelector(selector);
const el = {
  taskList: $('#task-list'),
  varList: $('#var-list'),
  newVar: $('#new-var'),
  deleteVars: $('#delete-vars'),
  doneVars: $('#done-vars'),
  varsButton: $('#vars-button'),
  varsPopover: $('#vars-popover'),
  sidebarToggle: $('#sidebar-toggle'),
  historyButton: $('#history-button'),
  historyPopover: $('#history-popover'),
  deleteRuns: $('#delete-runs'),
  doneRuns: $('#done-runs'),
  edit: $('#edit'),
  dirty: $('#dirty'),
  // The selected task's name in the Tasks list while editing it; one element, kept so typing survives redraws.
  taskName: h('input', { class: 'task-name', 'aria-label': 'Task name', title: 'Task name. Save renames the task.', spellcheck: 'false', autocomplete: 'off' }),
  save: $('#save'),
  delete: $('#delete'),
  run: $('#run'),
  stop: $('#stop'),
  editor: $('#editor'),
  editorWrap: $('#editor-wrap'),
  insertVar: $('#insert-var'),
  insertVarPopover: $('#insert-var-popover'),
  insertVarFilter: $('#insert-var-filter'),
  insertVarList: $('#insert-var-list'),
  runList: $('#run-list'),
  runView: $('#run-view'),
  lightbox: $('#lightbox'),
  aboutButton: $('#about-button'),
  about: $('#about'),
  aboutClose: $('#about-close'),
  settingsButton: $('#settings-button'),
  settings: $('#settings'),
  settingsForm: $('#settings-form'),
  settingsCancel: $('#settings-cancel'),
  settingsSave: $('#settings-save'),
  settingsError: $('#settings-error'),
  modelFields: $('#model-fields'),
  secretFields: $('#secret-fields'),
  secretList: $('#secret-list'),
  toast: $('#toast'),
};

const LABELS = { running: 'Running', passed: 'Passed', failed: 'Failed', error: 'Error' };
const ICONS = {
  remove: 'M18 6 6 18M6 6l12 12',
  chevron: 'm4 8 8 8 8-8', // spans the viewBox like the other icons, so the gap to its neighbour looks the same
};

const state = {
  tasks: [], // [{ name, lastRun }]
  vars: { file: '', vars: {} }, // public {{vars.NAME}} values, added and edited from the Variables popover
  deletingVars: false, // the bin next to + New was clicked: each variable shows a ✕ until Done
  runs: [], // finished run summaries, newest first
  deletingRuns: false, // the bin in Run history was clicked: each finished run shows a ✕ until Done
  selected: null, // task open in the editor
  saved: '', // editor content as last loaded or saved
  editing: false, // the editor is read-only until the edit button is pressed
  lives: new Map(), // latest run of each task started from the UI, built from server events; several can run at once
  view: null, // run shown on the right: one of state.lives, a past run, or null
  shot: 0, // index of the screenshot open in the lightbox
  caret: null, // last cursor position in the editor, where + Variable inserts
};

const isDirty = () => state.selected !== null && (getText() !== state.saved || nameChanged());
const isRunning = (task) => state.lives.get(task)?.status === 'running';
const anyRunning = () => [...state.lives.values()].some((run) => run.status === 'running');
const enc = encodeURIComponent;

// --- Tasks and editor ---

async function refresh() {
  [state.tasks, state.runs] = await Promise.all([api('GET', '/api/tasks'), api('GET', '/api/runs')]);
  renderTasks();
  renderHistory();
}

async function selectTask(name) {
  if (name === state.selected) return;
  if (isDirty() && !confirm(`Discard unsaved changes to ${state.selected}?`)) return;
  const { content } = await api('GET', `/api/tasks/${enc(name)}`);
  state.selected = name;
  state.editing = false;
  setText(content.replace(/\r\n?/g, '\n'));
  state.saved = getText();
  history.replaceState(null, '', `#${enc(name)}`);
  renderEditor();
  renderTasks();
  renderHistory();
  if (state.lives.has(name)) return showRun(state.lives.get(name));
  const latest = state.runs.find((run) => run.task === name);
  if (latest) await openRun(latest.id);
  else showRun(null);
}

const baseName = (task) => task.replace(/\.md$/, '');
const nameChanged = () => state.editing && el.taskName.value.trim() !== baseName(state.selected);

/** Saves the text, then the new name if it was changed. A failed rename (name taken) leaves you editing. */
async function save() {
  if (!isDirty()) return;
  const content = getText();
  if (content !== state.saved) {
    await api('PUT', `/api/tasks/${enc(state.selected)}`, { content });
    state.saved = content;
  }
  if (nameChanged()) await renameTask(el.taskName.value.trim());
  state.editing = false;
  renderEditor();
}

async function renameTask(newName) {
  const old = state.selected;
  const { name } = await api('POST', `/api/tasks/${enc(old)}/rename`, { name: newName });
  state.lives.delete(old);
  state.selected = name;
  history.replaceState(null, '', `#${enc(name)}`);
  await refresh();
  const latest = state.runs.find((run) => run.task === name);
  if (state.view?.task === old) await (latest ? openRun(latest.id) : showRun(null));
}

function toggleEdit() {
  if (state.editing) {
    if (isDirty() && !confirm(`Discard unsaved changes to ${state.selected}?`)) return;
    setText(state.saved);
    state.editing = false;
  } else {
    state.editing = true;
    el.taskName.value = baseName(state.selected);
  }
  renderEditor();
  if (state.editing) el.editor.focus(); // only once it is editable
}

async function run() {
  await save();
  await api('POST', '/api/runs', { task: state.selected });
}

async function stop() {
  const task = state.selected;
  state.lives.get(task).stopping = true;
  render();
  await api('POST', '/api/runs/stop', { task });
}

async function deleteTask() {
  const name = state.selected;
  const message = `Delete ${name.replace(/\.md$/, '')}?\n\nIt is moved to the .deleted folder inside the tasks folder, so it can be recovered from there. Its past runs are kept.`;
  if (!confirm(message)) return;
  await api('DELETE', `/api/tasks/${enc(name)}`);
  Object.assign(state, { selected: null, editing: false, saved: '' });
  setText('');
  history.replaceState(null, '', location.pathname);
  await refresh();
  if (state.tasks[0]) return selectTask(state.tasks[0].name);
  renderEditor();
  showRun(null);
}

async function newTask() {
  const name = prompt('Name of the new task (saved as tasks/<name>.md):')?.trim();
  if (!name) return;
  const created = await api('POST', '/api/tasks', { name });
  await refresh();
  await selectTask(created.name);
  toggleEdit();
}

function renderTasks() {
  // The once-a-second redraw during a run would cancel a drag, or take the cursor out of the name being typed.
  if (el.taskList.querySelector('.dragging') || (state.editing && document.activeElement === el.taskName)) return;
  el.taskList.replaceChildren(
    ...state.tasks.map(({ name, lastRun }) => {
      const status = lastRun?.status;
      const renaming = name === state.selected && state.editing;
      return h(
        'li',
        { class: name === state.selected ? 'active' : '', draggable: String(!renaming), 'data-name': name, onclick: guarded(() => selectTask(name)) },
        renaming ? el.taskName : h('span', { class: 'name' }, name.replace(/\.md$/, '')),
        isRunning(name) ? spinner() : status && h('span', { class: `dot ${status}`, title: LABELS[status] }),
      );
    }),
  );
}

async function refreshVars() {
  state.vars = await api('GET', '/api/vars');
  if (!el.varList.querySelector('input')) renderVars(); // don't throw away a value being typed
}

function renderVars() {
  refreshChips(); // a variable added or deleted changes which placeholders are unknown
  if (el.insertVarPopover.matches(':popover-open')) renderInsertVars();
  const { file, vars } = state.vars;
  const entries = Object.entries(vars);
  const deleting = state.deletingVars && entries.length > 0;
  el.deleteVars.hidden = deleting;
  el.deleteVars.disabled = !entries.length;
  el.doneVars.hidden = !deleting;
  el.varList.classList.toggle('deleting', deleting);
  el.varList.title = deleting ? 'Click ✕ to delete a variable.' : `Saved in ${file}. Click a variable to edit its value.`;
  el.varList.replaceChildren(
    ...(entries.length
      ? entries.map(([name, value]) =>
          h(
            'li',
            { title: value, draggable: String(!deleting), 'data-name': name, onclick: deleting ? undefined : (event) => editVar(event.currentTarget, name, value) },
            h('div', { class: 'var' }, h('span', { class: 'name' }, name), h('span', { class: 'value' }, value)),
            deleting && h('button', { class: 'icon remove', title: `Delete ${name}`, onclick: guarded((event) => deleteVar(event, name)) }, icon(ICONS.remove)),
          ),
        )
      : [h('li', { class: 'none' }, 'None yet.')]),
  );
}

/** Positions a popover below its button, or to its right with `beside`, kept inside the window. */
function placePopover(popover, button, beside = false) {
  const rect = button.getBoundingClientRect();
  const width = Math.min(300, innerWidth - 16); // matches the CSS width; it can't be measured before the popover opens
  popover.style.top = `${beside ? rect.top : rect.bottom + 4}px`;
  popover.style.left = `${Math.max(8, Math.min(beside ? rect.right + 4 : rect.left, innerWidth - width - 8))}px`;
}

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle('collapsed', collapsed);
  el.sidebarToggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  localStorage.setItem('sidebarCollapsed', collapsed);
}

/** Swaps the value for a text box. Enter or clicking away saves, Esc cancels. */
function editVar(item, name, value) {
  if (item.querySelector('input')) return;
  item.draggable = false; // so text in the box can be selected with the mouse
  const input = h('input', { class: 'value', value, 'aria-label': `Value of ${name}` });
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    try {
      if (save && input.value !== value) {
        await api('PUT', `/api/vars/${enc(name)}`, { value: input.value });
        state.vars.vars[name] = input.value;
      }
    } catch (err) {
      toast(err.message);
    } finally {
      renderVars();
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finish(true);
    if (event.key === 'Escape') {
      event.preventDefault(); // keeps the popover open
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  item.querySelector('.value').replaceWith(input);
  input.focus();
  input.select();
}

/** Adds a row with name and value boxes at the top. Enter saves, Esc cancels, and so does leaving it with no name. */
function newVar() {
  if (state.deletingVars) setDeletingVars(false);
  const existing = el.varList.querySelector('li.new');
  if (existing) return existing.querySelector('input').focus();
  const name = h('input', { class: 'name', placeholder: 'NAME', 'aria-label': 'Variable name', spellcheck: 'false' });
  const value = h('input', { class: 'value', placeholder: 'Value', 'aria-label': 'Variable value' });
  const item = h('li', { class: 'new' }, h('div', { class: 'var' }, name, value));
  let saving = false;
  const save = async () => {
    const key = name.value.trim();
    if (!key) return renderVars();
    if (saving) return;
    try {
      saving = true;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Variable names may only contain letters, digits and _, and cannot start with a digit');
      if (Object.hasOwn(state.vars.vars, key)) throw new Error(`${key} already exists. Click it to change its value.`);
      await api('PUT', `/api/vars/${enc(key)}`, { value: value.value });
      state.vars.vars[key] = value.value;
      renderVars();
    } catch (err) {
      toast(err.message);
      name.focus();
    } finally {
      saving = false;
    }
  };
  item.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      if (event.target === name && !value.value) value.focus();
      else save();
    }
    if (event.key === 'Escape') {
      event.preventDefault(); // keeps the popover open
      renderVars();
    }
  });
  item.addEventListener('focusout', (event) => {
    if (!item.contains(event.relatedTarget) && item.isConnected) save();
  });
  if (el.varList.querySelector('li.none')) el.varList.replaceChildren();
  el.varList.prepend(item);
  name.focus();
}

function setDeletingVars(on) {
  state.deletingVars = on;
  renderVars();
}

/** Asks first, naming the tasks that use the variable, since they fail without it. */
async function deleteVar(event, name) {
  event.stopPropagation(); // clicking the row edits the value
  const { usedBy } = await api('GET', '/api/vars');
  const tasks = (usedBy[name] ?? []).map((task) => task.replace(/\.md$/, ''));
  const one = tasks.length === 1;
  const warning = tasks.length
    ? `\n\nIt is used by ${one ? '1 task' : `${tasks.length} tasks`}: ${tasks.join(', ')}. ${one ? 'It' : 'They'} will stop working until you add the variable back or remove it from ${one ? 'that task' : 'those tasks'}.`
    : '';
  if (!confirm(`Delete ${name}?${warning}`)) return;
  await api('DELETE', `/api/vars/${enc(name)}`);
  delete state.vars.vars[name];
  renderVars();
}

function renderEditor() {
  el.editorWrap.classList.toggle('reading', Boolean(state.selected) && !state.editing); // placeholders can be clicked
  el.editor.classList.toggle('blank', !state.selected);
  if (el.editor.contentEditable !== String(state.editing)) el.editor.contentEditable = String(state.editing);
  el.editor.setAttribute('aria-readonly', String(!state.editing));
  el.insertVar.hidden = !state.editing;
  if (!state.editing && el.insertVarPopover.matches(':popover-open')) el.insertVarPopover.hidePopover();
  el.edit.disabled = !state.selected;
  el.edit.classList.toggle('active', state.editing);
  el.edit.title = state.editing ? 'Stop editing' : 'Edit';
  el.edit.setAttribute('aria-pressed', state.editing);
  el.dirty.hidden = !isDirty();
  el.save.hidden = !state.editing;
  el.save.disabled = !isDirty();
  el.delete.hidden = !state.editing;
  renderTasks(); // shows or hides the name box in the Tasks list
  const live = state.lives.get(state.selected);
  const runningHere = isRunning(state.selected);
  el.run.hidden = runningHere;
  el.run.disabled = !state.selected;
  el.stop.hidden = !runningHere;
  el.stop.disabled = Boolean(live?.stopping);
  el.stop.textContent = live?.stopping ? 'Stopping…' : 'Stop';
}

function renderHistory() {
  const runs = state.runs.filter((run) => run.task === state.selected);
  // The live run tops the list until it is finished and listed by the server.
  const live = state.lives.get(state.selected);
  if (live && !runs.some((run) => run.id === live.id)) runs.unshift(live);
  const finished = runs.filter((run) => run.status !== 'running');
  const deleting = state.deletingRuns && finished.length > 0;
  el.deleteRuns.hidden = deleting;
  el.deleteRuns.disabled = !finished.length;
  el.doneRuns.hidden = !deleting;
  el.runList.classList.toggle('deleting', deleting);
  if (!runs.length) return el.runList.replaceChildren(h('li', { class: 'none' }, state.selected ? 'No runs yet.' : ''));
  el.runList.replaceChildren(
    ...runs.map((run) => {
      const isLive = run === live;
      const running = run.status === 'running';
      const steps = isLive ? live.items.filter((item) => item.type === 'step').length : run.steps;
      const open = async () => (el.historyPopover.hidePopover(), isLive ? showRun(live) : openRun(run.id));
      return h(
        'li',
        { class: (isLive ? state.view === live : state.view?.id === run.id) ? 'active' : '', onclick: deleting ? undefined : guarded(open), title: run.summary },
        running ? spinner() : h('span', { class: `dot ${run.status}`, title: LABELS[run.status] }),
        h('span', { class: 'name' }, formatDate(run.startedAt)),
        h('span', { class: 'meta' }, `${formatDuration(run.durationMs ?? Date.now() - Date.parse(run.startedAt))} · ${steps} steps`),
        deleting && !running && h('button', { class: 'icon remove', title: 'Delete this run', onclick: guarded((event) => deleteRun(event, run)) }, icon(ICONS.remove)),
      );
    }),
  );
}

function setDeletingRuns(on) {
  state.deletingRuns = on;
  renderHistory();
}

/** Asks first, since the run's folder with its report and screenshots is deleted for good. */
async function deleteRun(event, run) {
  event.stopPropagation(); // clicking the row opens the run
  if (!confirm(`Delete the run from ${formatDate(run.startedAt)}?\n\nIts report and screenshots are deleted from the runs folder and cannot be recovered.`)) return;
  await api('DELETE', `/api/runs/${enc(run.id)}`);
  if (state.lives.get(run.task)?.id === run.id) state.lives.delete(run.task);
  await refresh();
  if (state.view?.id !== run.id) return;
  const latest = state.runs.find((other) => other.task === run.task);
  if (state.lives.has(run.task)) showRun(state.lives.get(run.task));
  else if (latest) await openRun(latest.id);
  else showRun(null);
}

// --- Runs ---

async function openRun(id) {
  const live = [...state.lives.values()].find((run) => run.id === id);
  if (live) return showRun(live);
  const result = await api('GET', `/api/runs/${enc(id)}`);
  showRun({
    id,
    dir: result.runDir,
    task: result.task.split(/[\/]/).pop(),
    status: result.status,
    summary: result.summary,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    items: result.steps.map((step) => ({ type: 'step', step })),
  });
}

function showRun(run) {
  state.view = run;
  el.runView.className = run ? '' : 'empty';
  if (run) el.runView.replaceChildren(runHeader(run), h('ol', { class: 'steps' }, run.items.map((item) => itemView(run, item))));
  else el.runView.replaceChildren('No runs yet.');
  renderHistory();
}

function runHeader(run) {
  const steps = run.items.filter((item) => item.type === 'step').length;
  const duration = run.durationMs ?? Date.now() - Date.parse(run.startedAt);
  const status = run.stopping && run.status === 'running' ? 'Stopping…' : LABELS[run.status];
  const collapsed = isRunHeaderCollapsed();
  const details = [
    run.summary && h('p', { class: 'summary' }, run.summary),
    rememberedView(run),
    run.dir &&
      h(
        'div',
        { class: 'meta' },
        'Evidence: ',
        h('code', {}, run.dir),
        run.status !== 'running' && [' · ', h('a', { href: `/runs/${enc(run.id)}/report.md`, target: '_blank' }, 'report.md')],
      ),
  ].filter(Boolean);
  return h(
    'header',
    { class: `run-header ${collapsed ? 'collapsed' : ''}` },
    h(
      'div',
      { class: 'run-title' },
      h('span', { class: `badge ${run.status}` }, status),
      details.length > 0 &&
        h(
          'button',
          {
            class: 'icon toggle',
            title: collapsed ? 'Show details' : 'Hide details',
            'aria-expanded': String(!collapsed),
            onclick: () => setRunHeaderCollapsed(!collapsed),
          },
          icon(ICONS.chevron),
        ),
    ),
    h('div', { class: 'meta' }, [formatDate(run.startedAt), formatDuration(duration), `${steps} step${steps === 1 ? '' : 's'}`].filter(Boolean).join(' · ')),
    details.length > 0 && h('div', { class: 'run-details' }, details),
  );
}

const isRunHeaderCollapsed = () => localStorage.getItem('runHeaderCollapsed') === 'true';

/** Folds the summary, saved values and evidence line under the status, keeping more room for the steps. Remembered across runs and reloads. */
function setRunHeaderCollapsed(collapsed) {
  localStorage.setItem('runHeaderCollapsed', collapsed);
  if (state.view) el.runView.querySelector('.run-header')?.replaceWith(runHeader(state.view));
}

/** Values the model saved with the remember tool, read from its steps so it works for live and past runs alike. */
function rememberedView(run) {
  const saved = new Map();
  for (const { type, step } of run.items) if (type === 'step' && step.tool === 'remember' && !step.error) saved.set(step.args.name, step.args.value);
  if (!saved.size) return null;
  return h('dl', { class: 'remembered' }, [...saved].map(([name, value]) => [h('dt', {}, name), h('dd', {}, value)]));
}

function itemView(run, item) {
  if (item.type === 'message') return h('li', { class: 'message' }, h('span', { class: 'num' }, '💬'), h('p', {}, item.text));
  const { step } = item;
  const kind = step.error ? 'error' : step.tool === 'finish' ? `verdict ${run.status}` : '';
  return h(
    'li',
    { class: `step ${kind}` },
    h('span', { class: 'num' }, step.step),
    h(
      'div',
      { class: 'body' },
      h('div', {}, step.message),
      step.error && h('pre', { class: 'error-text' }, step.error),
    ),
    step.screenshot &&
      run.id &&
      h('img', { class: 'thumb', src: shotUrl(run, step), loading: 'lazy', alt: `Step ${step.step}`, onclick: () => openShot(run, step) }),
  );
}

/** Redraws everything that depends on live runs. If `run` is on show, updates it, appending the new item instead of re-rendering the list. */
function render(item, run = state.view) {
  renderEditor();
  renderTasks();
  renderHistory();
  if (!run || state.view !== run || state.lives.get(run.task) !== run) return;
  el.runView.querySelector('.run-header')?.replaceWith(runHeader(run));
  const steps = el.runView.querySelector('.steps');
  if (!steps) return;
  const atBottom = steps.scrollHeight - steps.scrollTop - steps.clientHeight < 80;
  if (item) steps.append(itemView(run, item));
  if (item && atBottom) steps.scrollTop = steps.scrollHeight;
}

function connect() {
  const events = new EventSource('/api/events');
  events.onmessage = (message) => onEvent(JSON.parse(message.data));
}

function onEvent(event) {
  if (event.type === 'idle') {
    // The server restarted (e.g. npm run dev after a code change), and the runs it was doing are gone.
    for (const run of state.lives.values()) {
      if (run.status === 'running') Object.assign(run, { status: 'error', summary: 'The server restarted during this run, so the run stopped. Partial evidence may be in the run folder.' });
    }
    render();
    return void refresh().catch((err) => toast(err.message));
  }
  if (event.type === 'queued') {
    // Shown if its task is open; otherwise it is a spinner in the task list and a row in the task's history.
    const run = { task: event.task, startedAt: event.startedAt, status: 'running', items: [] };
    state.lives.set(event.task, run);
    if (event.task === state.selected) showRun(run);
    return render();
  }
  const run = state.lives.get(event.task);
  if (!run) return;
  switch (event.type) {
    case 'started':
      Object.assign(run, { id: event.id, dir: event.dir });
      return render(null, run);
    case 'message':
    case 'step':
      run.items.push(event);
      return render(event, run);
    case 'finished':
      Object.assign(run, { status: event.status, summary: event.summary, durationMs: event.durationMs });
      render(null, run);
      return void refresh().catch((err) => toast(err.message));
  }
}

// --- Settings: the model to use and the values tasks fill in for {{env.NAME}}, saved to .env by the server ---

let settingsRequired = false; // until QA Genie is set up, the dialog can't be closed

async function openSettings(required = false) {
  const settings = await api('GET', '/api/settings');
  const form = el.settingsForm;
  const keep = 'Saved. Leave empty to keep it.';
  settingsRequired = required;
  form.endpoint.value = settings.endpoint;
  form.model.value = settings.model;
  el.modelFields.hidden = Boolean(settings.endpoint && settings.model); // set up front (the zip, or .env); only shown when missing
  form.apiKey.value = '';
  form.apiKey.required = !settings.hasKey;
  form.apiKey.placeholder = settings.hasKey ? keep : 'Paste the key here';
  el.secretFields.hidden = !settings.secrets.length;
  el.secretList.replaceChildren(
    ...settings.secrets.map(({ name, set }) =>
      h('label', { class: 'field' }, h('code', {}, name), h('input', { type: 'password', 'data-secret': name, autocomplete: 'off', spellcheck: 'false', placeholder: set ? keep : 'Not set' })),
    ),
  );
  el.settingsError.hidden = true;
  el.settingsCancel.hidden = required;
  el.settings.showModal();
  (el.modelFields.hidden ? form.apiKey : form.endpoint).focus(); // not the API key's info button, which would open its tip
}

/** Saves after the server has checked the model answers, so a wrong key or endpoint shows here and not mid-run. */
async function saveSettings(event) {
  event.preventDefault();
  const form = el.settingsForm;
  const secrets = Object.fromEntries(
    [...el.secretList.querySelectorAll('input')].filter((input) => input.value).map((input) => [input.dataset.secret, input.value]),
  );
  el.settingsSave.disabled = true;
  el.settingsSave.textContent = 'Checking…';
  el.settingsError.hidden = true;
  try {
    await api('PUT', '/api/settings', { endpoint: form.endpoint.value.trim(), model: form.model.value.trim(), apiKey: form.apiKey.value.trim(), secrets });
    settingsRequired = false;
    el.settings.close();
  } catch (err) {
    el.settingsError.textContent = err.message;
    el.settingsError.hidden = false;
  } finally {
    el.settingsSave.disabled = false;
    el.settingsSave.textContent = 'Save';
  }
}

// --- Screenshot viewer ---

const shotUrl = (run, step) => `/runs/${enc(run.id)}/${step.screenshot}`;
const shotSteps = (run) => run.items.filter((item) => item.type === 'step' && item.step.screenshot).map((item) => item.step);

function openShot(run, step) {
  state.shot = shotSteps(run).indexOf(step);
  showShot(0);
  el.lightbox.showModal();
}

function showShot(delta) {
  const steps = shotSteps(state.view);
  state.shot = Math.min(Math.max(state.shot + delta, 0), steps.length - 1);
  const step = steps[state.shot];
  el.lightbox.querySelector('img').src = shotUrl(state.view, step);
  el.lightbox.querySelector('.caption').textContent = `Step ${step.step}: ${step.message}   (← → to browse, Esc to close)`;
}

// --- Helpers ---

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body && JSON.stringify(body),
  }).catch(() => {
    throw new Error('QA Genie is not running. Start it again (Start QA Genie, or npm run ui), then reload this page.');
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status} ${res.statusText}`);
  return res.status === 200 || res.status === 201 ? res.json() : undefined;
}

/** Wraps an async handler so failures show as a toast instead of disappearing into the console. */
function guarded(fn) {
  return (...args) => fn(...args).catch((err) => toast(err.message));
}

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 6000);
}

/** Creates an element. Children are appended as text nodes, so page and model text can never inject HTML. */
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.flat(Infinity).filter((child) => child !== undefined && child !== null && child !== false && child !== ''));
  return node;
}

/** A spinning ring. Its spin is offset by the clock, so the once-a-second redraw doesn't restart it. */
function spinner() {
  return h('span', { class: 'spinner', title: LABELS.running, style: `animation-delay: -${Math.round(performance.now() % 800)}ms` });
}

/** Creates a line icon from SVG path data; styled by `button.icon svg`. */
function icon(d) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// --- Task editor: {{vars.NAME}} and {{env.NAME}} show as chips with just the name, and are saved as written ---

const PLACEHOLDER = /\{\{\s*(vars|env)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const HAS_PLACEHOLDER = new RegExp(PLACEHOLDER.source);

/** A placeholder as one uneditable piece showing its name; `raw` is the text it stands for in the task file. */
function chip(raw, kind, name) {
  const node = h('span', { class: 'chip', contenteditable: 'false', 'data-raw': raw, 'data-env': String(kind === 'env'), 'data-name': name }, name);
  styleChip(node);
  return node;
}

/** Sets the colour and tooltip from the current variables: a {{vars.NAME}} with no such variable would fail the task. */
function styleChip(node) {
  const { name } = node.dataset;
  const type = node.dataset.env === 'true' ? 'env' : Object.hasOwn(state.vars.vars, name) ? 'var' : 'unknown';
  node.className = `chip ${type}`;
  node.dataset.kind = type;
  node.title = {
    var: `${node.dataset.raw}\n${name} = ${state.vars.vars[name]}\nClick to show it in Variables.`,
    env: `${node.dataset.raw}\n${name} is set in Settings and never shown to the AI model.\nClick to open Settings.`,
    unknown: `${node.dataset.raw}\nThere is no variable called ${name}, so this task would fail.\nClick to add it.`,
  }[type];
}

const refreshChips = () => el.editor.querySelectorAll('.chip').forEach(styleChip);

function setText(text) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    parts.push(text.slice(last, match.index), chip(match[0], match[1], match[2]));
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  el.editor.replaceChildren(...parts.filter((part) => part !== ''));
  ensureEndBreak();
}

/** The editor's text as saved to the task file: chips become their placeholders again. */
const getText = () => serialize(el.editor.childNodes);

function serialize(nodes) {
  let text = '';
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) text += node.data;
    else if (node.dataset?.raw) text += node.dataset.raw;
    else if (node.nodeName === 'BR') text += node === nodes[nodes.length - 1] ? '' : '\n'; // the trailing <br> isn't text
    else if (node.nodeName === 'DIV' || node.nodeName === 'P') text += (text && !text.endsWith('\n') ? '\n' : '') + serialize(node.childNodes);
    else text += serialize(node.childNodes);
  }
  return text;
}

/** A trailing <br>, not part of the text, so a final empty line shows and the cursor can go onto it. */
function ensureEndBreak() {
  if (el.editor.lastChild?.nodeName !== 'BR') el.editor.append(h('br'));
}

/** Where the cursor is, counted in the saved text. */
function caretOffset() {
  const selection = getSelection();
  if (!selection.rangeCount || !el.editor.contains(selection.anchorNode)) return null;
  const range = document.createRange();
  range.selectNodeContents(el.editor);
  range.setEnd(selection.focusNode, selection.focusOffset);
  return serialize(range.cloneContents().childNodes).length;
}

function setCaret(offset) {
  const range = document.createRange();
  range.setStart(el.editor, el.editor.childNodes.length - 1); // before the trailing <br>, if nothing else matches
  let left = offset;
  for (const node of el.editor.childNodes) {
    // Text takes the cursor at its end; a chip or <br> passes it on, so it lands in the text after a chip where typing works.
    if (node.nodeType === Node.TEXT_NODE) {
      if (left <= node.data.length) {
        range.setStart(node, left);
        break;
      }
      left -= node.data.length;
      continue;
    }
    const length = node.dataset?.raw ? node.dataset.raw.length : node === el.editor.lastChild ? 0 : 1;
    if (left < length || (left === 0 && length === 0)) {
      range.setStartBefore(node);
      break;
    }
    left -= length;
  }
  range.collapse(true);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
}

/** After typing or pasting: a placeholder typed in full becomes a chip, keeping the cursor where it was. */
function onEditorInput() {
  const typed = [...el.editor.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && HAS_PLACEHOLDER.test(node.data));
  const structured = el.editor.querySelector('div, p'); // in case the browser wrapped a line
  if (typed || structured) {
    const offset = caretOffset();
    setText(getText());
    if (offset !== null) setCaret(offset);
  }
  ensureEndBreak();
  renderEditor();
}

/** Keeps the editor plain text: Enter adds a newline, paste and copy use plain text with chips as their placeholders. */
function wireEditor() {
  el.editor.addEventListener('input', onEditorInput);
  el.editor.addEventListener('beforeinput', (event) => {
    if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      event.preventDefault();
      document.execCommand('insertText', false, '\n');
    }
  });
  el.editor.addEventListener('paste', (event) => {
    event.preventDefault();
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'));
  });
  el.editor.addEventListener('drop', (event) => event.preventDefault());
  const copy = (event) => {
    const selection = getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', serialize(selection.getRangeAt(0).cloneContents().childNodes));
    if (event.type === 'cut' && state.editing) document.execCommand('delete');
  };
  el.editor.addEventListener('copy', copy);
  el.editor.addEventListener('cut', copy);
  document.addEventListener('selectionchange', () => {
    const selection = getSelection();
    if (selection.rangeCount && el.editor.contains(selection.anchorNode)) state.caret = selection.getRangeAt(0).cloneRange();
  });
  el.editor.addEventListener('click', guarded(showPlaceholder));
}

// --- + Variable: picks a variable and inserts it at the cursor ---

// The sign-in email from Settings tops the list; its value is secret, so the row says where it comes from instead.
const PINNED = [{ kind: 'env', name: 'LOGIN_EMAIL', value: 'Your sign-in email, set in Settings' }];

function renderInsertVars() {
  const query = el.insertVarFilter.value.trim().toLowerCase();
  const entries = [...PINNED, ...Object.entries(state.vars.vars).map(([name, value]) => ({ kind: 'vars', name, value }))];
  const matches = entries.filter(({ name, value }) => !query || name.toLowerCase().includes(query) || String(value).toLowerCase().includes(query));
  el.insertVarFilter.hidden = entries.length < 3;
  if (!matches.length) return el.insertVarList.replaceChildren(h('li', { class: 'none' }, `No variable matches “${el.insertVarFilter.value.trim()}”.`));
  const focused = el.insertVarList.contains(document.activeElement) ? document.activeElement.dataset.key : null; // variables reload when the window regains focus
  el.insertVarList.replaceChildren(
    ...matches.map(({ kind, name, value }) =>
      h(
        'li',
        { class: kind, role: 'option', tabindex: '0', title: `Insert ${name}`, 'data-key': `${kind}.${name}`, onclick: () => insertVar(kind, name) },
        h('div', { class: 'var' }, h('span', { class: 'name' }, name), h('span', { class: 'value' }, value)),
      ),
    ),
    ...(entries.length === PINNED.length ? [h('li', { class: 'none' }, 'No variables yet. ', h('button', { onclick: addVarFromPicker }, 'Add a variable'))] : []),
  );
  if (focused) el.insertVarList.querySelector(`li[data-key="${focused}"]`)?.focus();
}

function addVarFromPicker() {
  el.insertVarPopover.hidePopover();
  el.varsPopover.showPopover();
  newVar();
}

/** Inserts the chip where the cursor last was in the editor, or at the end. Ctrl+Z takes it out again. */
function insertVar(kind, name) {
  el.insertVarPopover.hidePopover();
  el.editor.focus();
  const range = state.caret;
  if (range && el.editor.contains(range.startContainer)) {
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  } else {
    setCaret(getText().length);
  }
  const raw = `{{${kind}.${name}}}`;
  const offset = caretOffset();
  document.execCommand('insertHTML', false, chip(raw, kind, name).outerHTML);
  setCaret(offset + raw.length); // Chrome leaves the cursor where typing goes nowhere after an uneditable element
}

function onInsertVarKey(event) {
  const items = [...el.insertVarList.querySelectorAll('li[data-key]')];
  const index = items.indexOf(document.activeElement);
  if (event.key === 'Enter' && (index >= 0 || event.target === el.insertVarFilter)) {
    event.preventDefault();
    const item = index >= 0 ? items[index] : items[0];
    if (item) insertVar(...item.dataset.key.split('.'));
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, items.length - 1) : index - 1;
    (next < 0 && !el.insertVarFilter.hidden ? el.insertVarFilter : items[Math.max(next, 0)])?.focus();
  }
}

/** Clicking a placeholder while reading a task: shows the variable, or Settings for {{env.NAME}}, or starts adding a missing variable. */
async function showPlaceholder(event) {
  const mark = event.target.closest('.chip');
  if (!mark || state.editing) return;
  const { kind, name } = mark.dataset;
  if (kind === 'env') {
    await openSettings();
    return el.secretList.querySelector(`[data-secret="${name}"]`)?.focus();
  }
  if (!el.varsPopover.matches(':popover-open')) el.varsPopover.showPopover();
  if (kind === 'unknown') {
    newVar();
    const row = el.varList.querySelector('li.new');
    row.querySelector('input.name').value = name;
    return row.querySelector('input.value').focus();
  }
  const row = el.varList.querySelector(`li[data-name="${name}"]`);
  row?.scrollIntoView({ block: 'nearest' });
  row?.classList.remove('flash');
  void row?.offsetWidth; // restarts the animation when clicked twice
  row?.classList.add('flash');
}

// --- Reordering tasks and variables by dragging ---

/**
 * Lets the items of a list (li with data-name) be dragged into a new order. Items move as you drag;
 * dropping calls save(names), Esc or a failed save puts the list back with render().
 */
function sortable(list, save, render) {
  let dragged = null;
  let before = [];
  const names = () => [...list.querySelectorAll('li[data-name]')].map((item) => item.dataset.name);
  list.addEventListener('dragstart', (event) => {
    dragged = event.target.closest?.('li[data-name]');
    if (!dragged) return;
    before = names();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragged.dataset.name);
    dragged.classList.add('dragging');
  });
  list.addEventListener('dragover', (event) => {
    const over = event.target.closest?.('li[data-name]');
    if (!dragged || !over) return;
    event.preventDefault(); // allows dropping here
    if (over === dragged) return;
    const { top, height } = over.getBoundingClientRect();
    if (event.clientY < top + height / 2) over.before(dragged);
    else over.after(dragged);
  });
  list.addEventListener('drop', (event) => dragged && event.preventDefault());
  list.addEventListener('dragend', (event) => {
    if (!dragged) return;
    dragged.classList.remove('dragging');
    dragged = null;
    const after = names();
    if (event.dataTransfer.dropEffect === 'none') return render(); // cancelled
    if (after.join('\n') === before.join('\n')) return;
    save(after).catch((err) => (toast(err.message), render()));
  });
}

async function saveTaskOrder(names) {
  await api('PUT', '/api/task-order', { names });
  state.tasks.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
}

async function saveVarOrder(names) {
  await api('PUT', '/api/var-order', { names });
  state.vars.vars = Object.fromEntries(names.map((name) => [name, state.vars.vars[name]]));
}

// --- Wiring ---

wireEditor();
el.taskName.addEventListener('input', renderEditor);
el.taskName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') guarded(save)();
  if (event.key === 'Escape') {
    el.taskName.value = baseName(state.selected);
    renderEditor();
  }
});
el.insertVarPopover.addEventListener('beforetoggle', (event) => {
  if (event.newState !== 'open') return;
  placePopover(el.insertVarPopover, el.insertVar);
  el.insertVarFilter.value = '';
  renderInsertVars();
});
el.insertVarPopover.addEventListener('toggle', (event) => {
  if (event.newState === 'open') (el.insertVarFilter.hidden ? el.insertVarList.querySelector('li[data-key], button') : el.insertVarFilter)?.focus();
});
el.insertVarPopover.addEventListener('keydown', onInsertVarKey);
el.insertVarFilter.addEventListener('input', renderInsertVars);
el.edit.addEventListener('click', toggleEdit);
el.save.addEventListener('click', guarded(save));
el.delete.addEventListener('click', guarded(deleteTask));
el.run.addEventListener('click', guarded(run));
el.stop.addEventListener('click', guarded(stop));
$('#new-task').addEventListener('click', guarded(newTask));
el.newVar.addEventListener('click', newVar);
el.deleteVars.addEventListener('click', () => setDeletingVars(true));
el.doneVars.addEventListener('click', () => setDeletingVars(false));
el.varsPopover.addEventListener('toggle', (event) => event.newState === 'closed' && setDeletingVars(false));
el.deleteRuns.addEventListener('click', () => setDeletingRuns(true));
el.doneRuns.addEventListener('click', () => setDeletingRuns(false));
el.historyPopover.addEventListener('toggle', (event) => event.newState === 'closed' && setDeletingRuns(false));
sortable(el.taskList, saveTaskOrder, renderTasks);
sortable(el.varList, saveVarOrder, renderVars);
el.settingsButton.addEventListener('click', guarded(() => openSettings()));
el.settingsForm.addEventListener('submit', saveSettings);
el.settingsCancel.addEventListener('click', () => el.settings.close());
el.settings.addEventListener('cancel', (event) => settingsRequired && event.preventDefault()); // Esc
el.aboutButton.addEventListener('click', () => el.about.showModal());
el.aboutClose.addEventListener('click', () => el.about.close());
el.about.addEventListener('click', (event) => event.target === el.about && el.about.close()); // the backdrop
el.varsPopover.addEventListener('beforetoggle', (event) => {
  if (event.newState === 'open') placePopover(el.varsPopover, el.varsButton, document.body.classList.contains('collapsed'));
});
el.historyPopover.addEventListener('beforetoggle', (event) => {
  if (event.newState === 'open') placePopover(el.historyPopover, el.historyButton);
});
setSidebarCollapsed(localStorage.getItem('sidebarCollapsed') === 'true');
el.sidebarToggle.addEventListener('click', () => setSidebarCollapsed(!document.body.classList.contains('collapsed')));
el.lightbox.addEventListener('click', () => el.lightbox.close());
el.lightbox.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft') showShot(-1);
  if (event.key === 'ArrowRight') showShot(1);
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault();
    guarded(save)();
  }
});
window.addEventListener('beforeunload', (event) => {
  if (isDirty()) event.preventDefault();
});
setInterval(() => anyRunning() && render(), 1000); // keeps the elapsed time ticking

window.addEventListener('focus', () => refreshVars().catch((err) => toast(err.message))); // picks up edits made outside the UI
const settings = await api('GET', '/api/settings').catch((err) => (toast(err.message), null));
await Promise.all([refresh(), refreshVars()]).catch((err) => toast(err.message));
const fromHash = decodeURIComponent(location.hash.slice(1));
const first = state.tasks.find((task) => task.name === fromHash) ?? state.tasks[0];
if (first) await selectTask(first.name).catch((err) => toast(err.message));
connect();
if (settings && (!settings.endpoint || !settings.model || !settings.hasKey)) await openSettings(true).catch((err) => toast(err.message));

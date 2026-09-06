const csrf = document.querySelector('meta[name="csrf-token"]').content;
const status = document.querySelector('#status');
const container = document.querySelector('#installations');
let availableModels = {};

document.querySelector('#logout').addEventListener('click', async () => {
  const response = await fetch('/logout', {
    method: 'POST',
    headers: { 'x-csrf-token': csrf },
  });
  if (response.redirected) window.location.assign(response.url);
  else status.textContent = 'Could not sign out.';
});

function option(value, selected) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = value;
  element.selected = value === selected;
  return element;
}

function renderInstallation(item) {
  const article = document.createElement('article');
  article.className = 'installation';
  const summary = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = item.account || `Installation ${item.id}`;
  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = `${item.repositorySelection} repositories | free plan | ${item.reviewsUsed}/${item.reviewLimit} reviews this month`;
  summary.append(title, meta);

  const form = document.createElement('form');
  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'toggle';
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.checked = item.settings.enabled;
  enabledLabel.append(enabled, document.createTextNode('Review new pull request revisions'));

  const providerLabel = document.createElement('label');
  providerLabel.textContent = 'Provider';
  const provider = document.createElement('select');
  for (const name of Object.keys(availableModels)) provider.append(option(name, item.settings.provider));
  providerLabel.append(provider);

  const modelLabel = document.createElement('label');
  modelLabel.textContent = 'Model';
  const model = document.createElement('select');
  const fillModels = () => {
    model.replaceChildren(...availableModels[provider.value].map((name) => option(name, item.settings.model)));
  };
  provider.addEventListener('change', fillModels);
  fillModels();
  modelLabel.append(model);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = 'Save settings';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'secondary';
  remove.textContent = 'Delete service data';
  actions.append(save, remove);
  form.append(enabledLabel, providerLabel, modelLabel, actions);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    const response = await fetch(`/api/installations/${item.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ enabled: enabled.checked, provider: provider.value, model: model.value }),
    });
    status.textContent = response.ok ? `Saved ${item.account}.` : 'Could not save settings.';
    save.disabled = false;
  });
  remove.addEventListener('click', async () => {
    if (!confirm('Delete stored settings, usage, and review job records for this installation?')) return;
    const response = await fetch(`/api/installations/${item.id}`, {
      method: 'DELETE', headers: { 'x-csrf-token': csrf },
    });
    if (response.ok) {
      article.remove();
      status.textContent = 'Service data deleted. Uninstall the app in GitHub to revoke repository access.';
    }
  });
  article.append(summary, form);
  return article;
}

fetch('/api/installations').then(async (response) => {
  if (!response.ok) throw new Error('request failed');
  const data = await response.json();
  availableModels = data.models;
  status.textContent = `Signed in as ${data.user.login}.`;
  if (!data.installations.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const message = document.createElement('p');
    message.textContent = 'No manageable second-opinion installations were found.';
    const install = document.createElement('a');
    install.className = 'install-link';
    install.href = data.installUrl;
    install.textContent = 'Install the GitHub App and choose repositories';
    empty.append(message, install);
    container.append(empty);
  } else {
    container.append(...data.installations.map(renderInstallation));
  }
}).catch(() => { status.textContent = 'Could not load installations.'; });

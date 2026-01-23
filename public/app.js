// State
let currentProject = null;
let currentBrowsePath = null;
let currentLogEventSource = null;
let currentTaskId = null;

// DOM Elements
const projectListView = document.getElementById('project-list-view');
const projectDetailView = document.getElementById('project-detail-view');
const projectsContainer = document.getElementById('projects-container');
const addProjectBtn = document.getElementById('add-project-btn');
const backBtn = document.getElementById('back-btn');
const projectNameEl = document.getElementById('project-name');
const projectPathEl = document.getElementById('project-path');
const dockerfileStatusEl = document.getElementById('dockerfile-status');
const taskPromptEl = document.getElementById('task-prompt');
const submitTaskBtn = document.getElementById('submit-task-btn');
const tasksContainer = document.getElementById('tasks-container');

// Modal Elements
const browseModal = document.getElementById('browse-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const cancelModalBtn = document.getElementById('cancel-modal-btn');
const selectFolderBtn = document.getElementById('select-folder-btn');
const currentPathLabel = document.getElementById('current-path-label');
const directoryList = document.getElementById('directory-list');

const logsModal = document.getElementById('logs-modal');
const closeLogsBtn = document.getElementById('close-logs-btn');
const closeLogsFooterBtn = document.getElementById('close-logs-footer-btn');
const inputContainer = document.getElementById('input-container');
const taskInputEl = document.getElementById('task-input');
const sendInputBtn = document.getElementById('send-input-btn');
const logsContent = document.getElementById('logs-content');
const stopTaskBtn = document.getElementById('stop-task-btn');

// API Functions
async function fetchProjects() {
  const response = await fetch('/api/projects');
  return response.json();
}

async function createProject(path) {
  const response = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  return response.json();
}

async function deleteProject(id) {
  await fetch(`/api/projects/${id}`, { method: 'DELETE' });
}

async function getDockerfileStatus(projectId) {
  const response = await fetch(`/api/projects/${projectId}/dockerfile`);
  return response.json();
}

async function generateDockerfile(projectId) {
  const response = await fetch(`/api/projects/${projectId}/generate-dockerfile`, {
    method: 'POST',
  });
  return response.json();
}

async function fetchTasks(projectId) {
  const response = await fetch(`/api/tasks/project/${projectId}`);
  return response.json();
}

async function createTask(projectId, prompt) {
  const response = await fetch(`/api/tasks/project/${projectId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  return response.json();
}

async function stopTask(taskId) {
  const response = await fetch(`/api/tasks/${taskId}/stop`, { method: 'POST' });
  return response.json();
}

async function sendTaskInput(taskId, input) {
  const response = await fetch(`/api/tasks/${taskId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  return response.json();
}

async function browsePath(path) {
  const url = path ? `/api/browse?path=${encodeURIComponent(path)}` : '/api/browse';
  const response = await fetch(url);
  return response.json();
}

// Render Functions
function renderProjects(projects) {
  if (projects.length === 0) {
    projectsContainer.innerHTML = `
      <div class="empty-state">
        <p>No projects yet. Add a project folder to get started.</p>
      </div>
    `;
    return;
  }

  projectsContainer.innerHTML = projects.map(project => `
    <div class="project-card" data-id="${project.id}">
      <h3>${escapeHtml(project.name)}</h3>
      <p class="path">${escapeHtml(project.path)}</p>
      <div class="status">
        <span class="status-indicator ${project.dockerfile_exists ? 'ready' : 'pending'}"></span>
        <span>${project.dockerfile_exists ? 'Ready' : 'Dockerfile needed'}</span>
      </div>
      <button class="btn btn-danger delete-btn" data-id="${project.id}" onclick="event.stopPropagation(); handleDeleteProject(${project.id})">Delete</button>
    </div>
  `).join('');

  // Add click handlers for project cards
  document.querySelectorAll('.project-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = parseInt(card.dataset.id);
      const project = projects.find(p => p.id === id);
      showProjectDetail(project);
    });
  });
}

function renderDockerfileStatus(status) {
  if (status.exists) {
    dockerfileStatusEl.innerHTML = `
      <div class="status-row">
        <span class="status-indicator ready"></span>
        <span class="text-success">Dockerfile ready</span>
      </div>
    `;
  } else {
    dockerfileStatusEl.innerHTML = `
      <div class="status-row">
        <span class="status-indicator pending"></span>
        <span class="text-warning">Dockerfile not found</span>
        <button class="btn btn-primary" id="generate-dockerfile-btn" style="margin-left: 15px;">Generate Dockerfile</button>
      </div>
    `;
    document.getElementById('generate-dockerfile-btn').addEventListener('click', handleGenerateDockerfile);
  }
}

function renderTasks(tasks) {
  if (tasks.length === 0) {
    tasksContainer.innerHTML = '<p class="text-muted">No tasks yet.</p>';
    return;
  }

  tasksContainer.innerHTML = tasks.map(task => `
    <div class="task-item" data-id="${task.id}">
      <div class="task-header">
        <div class="task-status">
          ${getStatusIcon(task.status)}
          <span>${capitalizeFirst(task.status)}</span>
        </div>
      </div>
      <p class="task-prompt">${escapeHtml(task.prompt)}</p>
      <p class="task-time">${formatDate(task.created_at)}</p>
    </div>
  `).join('');

  // Add click handlers for task items
  document.querySelectorAll('.task-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = parseInt(item.dataset.id);
      const task = tasks.find(t => t.id === id);
      showTaskLogs(task);
    });
  });
}

function renderDirectoryBrowser(data) {
  currentBrowsePath = data.currentPath;
  currentPathLabel.textContent = data.currentPath;

  let html = '';

  if (data.parentPath) {
    html += `
      <div class="directory-item parent" data-path="${escapeHtml(data.parentPath)}">
        <span class="icon">📁</span>
        <span>..</span>
      </div>
    `;
  }

  html += data.entries.map(entry => `
    <div class="directory-item" data-path="${escapeHtml(entry.path)}">
      <span class="icon">📁</span>
      <span>${escapeHtml(entry.name)}</span>
    </div>
  `).join('');

  if (data.entries.length === 0 && !data.parentPath) {
    html = '<p class="text-muted">No subdirectories found.</p>';
  }

  directoryList.innerHTML = html;

  // Add click handlers
  document.querySelectorAll('.directory-item').forEach(item => {
    item.addEventListener('click', () => {
      loadDirectory(item.dataset.path);
    });
  });
}

// Event Handlers
async function handleDeleteProject(id) {
  if (!confirm('Are you sure you want to delete this project?')) return;

  try {
    await deleteProject(id);
    loadProjects();
  } catch (err) {
    alert('Failed to delete project: ' + err.message);
  }
}

async function handleGenerateDockerfile() {
  const btn = document.getElementById('generate-dockerfile-btn');
  btn.disabled = true;
  btn.textContent = 'Generating...';

  try {
    const status = await generateDockerfile(currentProject.id);
    renderDockerfileStatus(status);
    currentProject.dockerfile_exists = 1;
  } catch (err) {
    alert('Failed to generate Dockerfile: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Generate Dockerfile';
  }
}

async function handleSubmitTask() {
  const prompt = taskPromptEl.value.trim();
  if (!prompt) {
    alert('Please enter a prompt');
    return;
  }

  submitTaskBtn.disabled = true;
  submitTaskBtn.textContent = 'Submitting...';

  try {
    const task = await createTask(currentProject.id, prompt);
    taskPromptEl.value = '';
    loadTasks();
    showTaskLogs(task);
  } catch (err) {
    alert('Failed to create task: ' + err.message);
  } finally {
    submitTaskBtn.disabled = false;
    submitTaskBtn.textContent = 'Submit Task';
  }
}

async function handleStopTask() {
  if (!currentTaskId) return;

  try {
    await stopTask(currentTaskId);
    stopTaskBtn.style.display = 'none';
  } catch (err) {
    alert('Failed to stop task: ' + err.message);
  }
}

// View Functions
function showProjectList() {
  projectDetailView.classList.remove('active');
  projectListView.classList.add('active');
  currentProject = null;
  loadProjects();
}

async function showProjectDetail(project) {
  currentProject = project;
  projectListView.classList.remove('active');
  projectDetailView.classList.add('active');

  projectNameEl.textContent = project.name;
  projectPathEl.textContent = project.path;

  // Load dockerfile status
  const status = await getDockerfileStatus(project.id);
  renderDockerfileStatus(status);

  // Load tasks
  loadTasks();
}

function showBrowseModal() {
  browseModal.classList.add('active');
  loadDirectory();
}

function hideBrowseModal() {
  browseModal.classList.remove('active');
}

function updateStatusBadge(status) {
  const badge = document.getElementById('task-status-indicator');
  badge.className = `task-status-badge ${status}`;

  const labels = {
    pending: '⏳ Pending',
    running: '<span class="spinner"></span> Running',
    completed: '✓ Completed',
    failed: '✗ Failed'
  };

  badge.innerHTML = labels[status] || status;
}

function showTaskLogs(task) {
  currentTaskId = task.id;
  logsModal.classList.add('active');
  logsContent.textContent = '';
  taskInputEl.value = '';

  // Show status badge, stop button, and input container based on status
  const isRunning = task.status === 'running';
  updateStatusBadge(task.status);
  stopTaskBtn.style.display = isRunning ? 'block' : 'none';
  inputContainer.style.display = isRunning ? 'flex' : 'none';

  // Close existing event source
  if (currentLogEventSource) {
    currentLogEventSource.close();
  }

  // Connect to SSE for logs
  currentLogEventSource = new EventSource(`/api/tasks/${task.id}/logs`);

  currentLogEventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'log') {
      logsContent.textContent += data.data;
      logsContent.scrollTop = logsContent.scrollHeight;
    } else if (data.type === 'end') {
      updateStatusBadge(data.status || 'completed');
      stopTaskBtn.style.display = 'none';
      inputContainer.style.display = 'none';
      loadTasks();
      currentLogEventSource.close();
    } else if (data.type === 'error') {
      logsContent.textContent += `\nError: ${data.message}\n`;
      updateStatusBadge('failed');
      inputContainer.style.display = 'none';
      stopTaskBtn.style.display = 'none';
      loadTasks();
      currentLogEventSource.close();
    }
  };

  currentLogEventSource.onerror = () => {
    currentLogEventSource.close();
  };
}

function hideLogsModal() {
  logsModal.classList.remove('active');
  currentTaskId = null;
  if (currentLogEventSource) {
    currentLogEventSource.close();
    currentLogEventSource = null;
  }
}

// Data Loading
async function loadProjects() {
  try {
    const projects = await fetchProjects();
    renderProjects(projects);
  } catch (err) {
    console.error('Failed to load projects:', err);
    projectsContainer.innerHTML = '<p class="text-danger">Failed to load projects.</p>';
  }
}

async function loadTasks() {
  if (!currentProject) return;

  try {
    const tasks = await fetchTasks(currentProject.id);
    renderTasks(tasks);
  } catch (err) {
    console.error('Failed to load tasks:', err);
    tasksContainer.innerHTML = '<p class="text-danger">Failed to load tasks.</p>';
  }
}

async function loadDirectory(path) {
  try {
    const data = await browsePath(path);
    renderDirectoryBrowser(data);
  } catch (err) {
    console.error('Failed to browse directory:', err);
    directoryList.innerHTML = '<p class="text-danger">Failed to browse directory.</p>';
  }
}

async function handleSelectFolder() {
  if (!currentBrowsePath) return;

  try {
    await createProject(currentBrowsePath);
    hideBrowseModal();
    loadProjects();
  } catch (err) {
    alert('Failed to add project: ' + (err.message || 'Unknown error'));
  }
}

// Utility Functions
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function capitalizeFirst(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleString();
}

function getStatusIcon(status) {
  switch (status) {
    case 'pending':
      return '<span class="text-muted">⏳</span>';
    case 'running':
      return '<span class="spinner"></span>';
    case 'completed':
      return '<span class="text-success">✓</span>';
    case 'failed':
      return '<span class="text-danger">✗</span>';
    default:
      return '';
  }
}

// Send input handler
async function handleSendInput() {
  if (!currentTaskId) return;

  const input = taskInputEl.value;
  if (!input && input !== '') return;

  sendInputBtn.disabled = true;
  taskInputEl.disabled = true;

  try {
    await sendTaskInput(currentTaskId, input);
    taskInputEl.value = '';
  } catch (err) {
    console.error('Failed to send input:', err);
  } finally {
    sendInputBtn.disabled = false;
    taskInputEl.disabled = false;
    taskInputEl.focus();
  }
}

// Event Listeners
addProjectBtn.addEventListener('click', showBrowseModal);
backBtn.addEventListener('click', showProjectList);
closeModalBtn.addEventListener('click', hideBrowseModal);
cancelModalBtn.addEventListener('click', hideBrowseModal);
selectFolderBtn.addEventListener('click', handleSelectFolder);
submitTaskBtn.addEventListener('click', handleSubmitTask);
closeLogsBtn.addEventListener('click', hideLogsModal);
closeLogsFooterBtn.addEventListener('click', hideLogsModal);
stopTaskBtn.addEventListener('click', handleStopTask);
sendInputBtn.addEventListener('click', handleSendInput);
taskInputEl.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') handleSendInput();
});

// Close modals on outside click
browseModal.addEventListener('click', (e) => {
  if (e.target === browseModal) hideBrowseModal();
});
logsModal.addEventListener('click', (e) => {
  if (e.target === logsModal) hideLogsModal();
});

// Initialize
loadProjects();

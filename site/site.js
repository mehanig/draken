'use strict';

// A small, self-contained illustration. No API calls, storage, account access,
// microphone, model invocation or application review state.
const examples = {
  E01: {
    role: 'pi · assistant',
    quote: 'Implemented a bounded retry for export uploads.',
    qualification: 'An agent-reported implementation. It is not a fresh inspection of the code or a production check by Draken.',
  },
  E02: {
    role: 'pi · tool result',
    quote: 'Tests: 5 passed, 0 failed.',
    qualification: 'Recorded test output, not an independent test run by Draken. This says nothing about deployment.',
  },
  E03: {
    role: 'pi · assistant',
    quote: 'Deployment has not been checked. Verify the production export path before treating this as complete.',
    qualification: 'The qualification belongs in the briefing too. Passing checks are not evidence of a verified deployment.',
  },
};

for (const button of document.querySelectorAll('[data-source]')) {
  button.addEventListener('click', () => {
    const id = button.dataset.source;
    const source = examples[id];
    if (!source) return;
    document.getElementById('source-id').textContent = id;
    document.getElementById('source-role').textContent = source.role;
    document.getElementById('source-quote').textContent = source.quote;
    document.getElementById('source-qualification').textContent = source.qualification;
    for (const reference of document.querySelectorAll('[data-source]')) {
      reference.setAttribute('aria-pressed', String(reference === button));
    }
  });
}

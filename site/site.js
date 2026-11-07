'use strict';

// A small, self-contained illustration. No API calls, storage, account access,
// microphone, model invocation or application review state.
const examples = {
  E01: {
    role: 'pi · assistant',
    quote: 'I added retries for failed export uploads.',
    qualification: 'This is what the agent said it changed. Draken hasn’t checked the code itself.',
  },
  E02: {
    role: 'pi · test output',
    quote: 'Tests: 5 passed, 0 failed.',
    qualification: 'These results came from the session log. Draken hasn’t run the tests or checked the live site.',
  },
  E03: {
    role: 'pi · assistant',
    quote: 'I haven’t checked the live site yet. Try an export there before calling this done.',
    qualification: 'The tests passed, but the agent still left something for you to check.',
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

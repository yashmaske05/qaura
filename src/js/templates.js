(function () {
  'use strict';

  // Built-in note templates for QA work. Your own templates live in data (noteTemplates).
  const QN = window.QN;
  const e = '<p><br></p>';
  const li = '<li><br></li>';
  const todo = (t) => `<li data-checked="false">${t}</li>`;
  const checklist = (...items) => `<ul data-checklist="">${items.map(todo).join('')}</ul>`;

  QN.noteTemplates = [
    {
      id: 'daily',
      name: 'Daily log',
      icon: 'calendar',
      html: `<h2>Focus</h2><ul>${li}</ul><h2>Notes</h2>${e}<h2>Follow-ups</h2>${checklist('')}`,
    },
    {
      id: 'test-case',
      name: 'Test case',
      icon: 'checklist',
      html: `<p><strong>ID:</strong> TC-</p><p><strong>Ticket / story:</strong> </p><p><strong>Priority:</strong> Medium</p>
<h3>Objective</h3>${e}
<h3>Preconditions</h3><ul>${li}</ul>
<h3>Test data</h3><ul>${li}</ul>
<h3>Steps</h3><ol>${li}</ol>
<h3>Expected result</h3>${e}
<h3>Actual result</h3>${e}
<h3>Result</h3>${checklist('Pass', 'Fail', 'Blocked')}`,
    },
    {
      id: 'test-plan',
      name: 'Test plan',
      icon: 'notes',
      html: `<h2>Overview</h2><p><strong>Release / feature:</strong> </p><p><strong>Owner:</strong> </p>
<h2>Scope</h2><h3>In scope</h3><ul>${li}</ul><h3>Out of scope</h3><ul>${li}</ul>
<h2>Approach</h2>${checklist('Smoke', 'Functional', 'Regression', 'API', 'UI / cross-browser', 'Performance', 'Security', 'Accessibility')}
<h2>Environments &amp; test data</h2><ul>${li}</ul>
<h2>Entry criteria</h2>${checklist('Build deployed to QA', 'Requirements signed off', 'Test data ready')}
<h2>Exit criteria</h2>${checklist('All critical / major bugs fixed and verified', 'Regression suite passed', 'Open risks accepted by product owner')}
<h2>Risks &amp; mitigations</h2><ul>${li}</ul>
<h2>Schedule</h2><ul>${li}</ul>`,
    },
    {
      id: 'exploratory',
      name: 'Exploratory session',
      icon: 'search',
      html: `<p><strong>Charter:</strong> Explore … with … to discover …</p><p><strong>Time box:</strong> 60 min</p><p><strong>Build / environment:</strong> </p>
<h3>Areas covered</h3><ul>${li}</ul>
<h3>Session notes</h3>${e}
<h3>Bugs found</h3><ul>${li}</ul>
<h3>Questions &amp; issues</h3><ul>${li}</ul>
<h3>Follow-ups</h3>${checklist('')}`,
    },
    {
      id: 'execution-summary',
      name: 'Test execution summary',
      icon: 'play',
      html: `<p><strong>Build:</strong> </p><p><strong>Environment:</strong> </p><p><strong>Test window:</strong> </p>
<h3>Results</h3><ul><li>Executed: </li><li>Passed: </li><li>Failed: </li><li>Blocked: </li><li>Not run: </li></ul>
<h3>Failed tests</h3><ul>${li}</ul>
<h3>Open bugs</h3><ul>${li}</ul>
<h3>Risks</h3><ul>${li}</ul>
<h3>Recommendation</h3>${checklist('Go', 'Go with known issues', 'No-go')}`,
    },
    {
      id: 'release-signoff',
      name: 'Release sign-off',
      icon: 'shield',
      html: `<p><strong>Release:</strong> </p><p><strong>Date:</strong> </p>
${checklist('Smoke test passed on production-like environment', 'Regression suite passed', 'No open critical / major bugs', 'Known issues documented in release notes', 'Rollback plan reviewed', 'Monitoring & alerts checked', 'Stakeholders informed')}
<h3>Notes</h3>${e}`,
    },
    {
      id: 'api-test',
      name: 'API test notes',
      icon: 'code',
      html: `<p><strong>Endpoint:</strong> </p><p><strong>Method:</strong> GET</p><p><strong>Auth:</strong> </p>
<h3>Request</h3><pre>{\n  \n}</pre>
<h3>Expected response</h3><pre>200 OK\n{\n  \n}</pre>
<h3>Checks</h3>${checklist('Status code', 'Response schema', 'Required fields present', 'Error handling (400 / 401 / 403 / 404 / 500)', 'Response time', 'Pagination / limits')}
<h3>Edge cases</h3><ul>${li}</ul>`,
    },
    {
      id: 'meeting',
      name: 'Meeting notes',
      icon: 'standup',
      html: `<p><strong>Date:</strong> </p><p><strong>Attendees:</strong> </p>
<h3>Agenda</h3><ul>${li}</ul>
<h3>Notes</h3>${e}
<h3>Decisions</h3><ul>${li}</ul>
<h3>Action items</h3>${checklist('')}`,
    },
  ];
})();

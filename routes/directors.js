export function register(ctx) {
  const { addRoute, json, readBody, directorService } = ctx;
  if (!directorService) return;

  addRoute('GET', '/api/directors', (_req, res) => json(res, directorService.summary()));

  addRoute('POST', '/api/directors/sync', (_req, res) => {
    try { json(res, { directors: directorService.syncProjects() }); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('GET', '/api/directors/runs/:id', (req, res) => {
    const run = directorService.getRun(req.params.id);
    if (!run) return json(res, { error: 'Run not found' }, 404);
    json(res, run);
  });

  addRoute('GET', '/api/directors/:id/goals/:goalId', (req, res) => {
    const goal = directorService.getGoal(req.params.goalId);
    if (!goal || goal.directorId !== req.params.id) return json(res, { error: 'Goal not found' }, 404);
    json(res, goal);
  });

  addRoute('POST', '/api/directors/:id/goals/:goalId/decision', async (req, res) => {
    try {
      const body = await readBody(req);
      json(res, await directorService.answerGoalDecision(req.params.id, req.params.goalId, body), 202);
    } catch (err) {
      const status = /not found/i.test(err.message) ? 404
        : /already running|not awaiting/i.test(err.message) ? 409 : 400;
      json(res, { error: err.message }, status);
    }
  });

  addRoute('GET', '/api/directors/:id/board', (req, res) => {
    try {
      json(res, {
        tasks: directorService.getBoard(req.params.id),
        status: directorService.getBoardStatus?.(req.params.id) || null,
      });
    }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('GET', '/api/directors/:id/tasks/:taskId', async (req, res) => {
    try { json(res, await directorService.getTaskDetails(req.params.id, req.params.taskId)); }
    catch (err) { json(res, { error: err.message }, /not found/i.test(err.message) ? 404 : 400); }
  });

  addRoute('GET', '/api/directors/:id/tasks/:taskId/trace', async (req, res) => {
    try { json(res, await directorService.getTaskTrace(req.params.id, req.params.taskId)); }
    catch (err) { json(res, { error: err.message }, /not found/i.test(err.message) ? 404 : 400); }
  });

  addRoute('POST', '/api/directors/:id/tasks/:taskId/interventions', async (req, res) => {
    try {
      const body = await readBody(req);
      json(res, await directorService.interveneTask(req.params.id, req.params.taskId, body.message), 202);
    } catch (err) { json(res, { error: err.message }, /not found/i.test(err.message) ? 404 : 400); }
  });

  addRoute('POST', '/api/directors/:id/tasks/:taskId/control', async (req, res) => {
    try {
      const body = await readBody(req);
      json(res, await directorService.controlTask(req.params.id, req.params.taskId, body.action, body.reason), 202);
    } catch (err) {
      const status = /not found/i.test(err.message) ? 404
        : /already running|terminal task|reached terminal state/i.test(err.message) ? 409 : 400;
      json(res, { error: err.message }, status);
    }
  });

  addRoute('POST', '/api/directors/:id/messages', async (req, res) => {
    try {
      const body = await readBody(req);
      json(res, directorService.submitMessage(req.params.id, body.prompt, { mode: body.mode }), 202);
    } catch (err) {
      const status = /not found/i.test(err.message) ? 404 : /already running|already supervises active Goal/i.test(err.message) ? 409 : 400;
      json(res, { error: err.message }, status);
    }
  });

  addRoute('POST', '/api/directors/:id/objectives', async (req, res) => {
    try {
      const body = await readBody(req);
      if (!body.title) return json(res, { error: 'title required' }, 400);
      json(res, await directorService.createObjective(req.params.id, body), 202);
    } catch (err) { json(res, { error: err.message }, 400); }
  });

  addRoute('POST', '/api/directors/:id/dispatch', async (req, res) => {
    try {
      const body = await readBody(req);
      json(res, await directorService.tickDirector(req.params.id, body.max));
    } catch (err) { json(res, { error: err.message }, 400); }
  });
}

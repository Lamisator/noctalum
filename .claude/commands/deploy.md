Run `./deploy.sh` from the workspace root to build and deploy Noctalum to the production server.

Accepted optional arguments (pass them through verbatim if the user included any):
- `--skip-build` — deploy already-built `dist/` artifacts without rebuilding
- `--transfer-db` — also push the local `noctalum.db` to the server

Steps:
1. Run `bash -n ./deploy.sh` first to syntax-check the script.
2. Ask the user to confirm before proceeding, showing the exact command you intend to run (e.g. `./deploy.sh` or `./deploy.sh --skip-build`).
3. Once confirmed, run the deploy command and stream the output.
4. Report success or surface any errors.

# Decisions

The current source checkout was stale; all implementation uses origin/main 3cd583d in isolated worktrees. Browser page has no icon link and favicon.ico under /admin returns SPA HTML; Chrome currently retains an inline SVG from another page. Use an explicit same-origin SVG under Vite public assets. Existing next-theme UI labels define the intended cycle. Quality metrics are evidence, not justification to rewrite applied SQL history or remove hidden/serial-execution guarantees. UI redesign and AI remain proposals. Minimo production is explicitly withheld.

## Audit and proposal evidence

All276 tracked shared runtime source files were read semantically with path/hash/range manifests, along with existing58 SQL migrations and synthetic FK/integrity application checks. Separate operator deliverables contain the redesigned schedule/detail proposal, help-AI/external-agent proposal and detailed audit. Proposals did not replace the live design or connect customer data to new providers. Verified defects have deterministic regressions; local simulation, remote CI and actual deployment proof remain distinct.

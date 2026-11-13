// Safe, read-only deployment diagnostics. Never returns secret values.
const json = (data, status = 200) => Response.json(data, {
  status,
  headers: { "Cache-Control": "no-store", "Pragma": "no-cache" }
});

export async function onRequestGet({ env }) {
  const token = String(env.GITHUB_ACTIONS_TOKEN || "").trim();
  const workerSecret = String(env.CF_WORKER_SECRET || "").trim();
  const kvAvailable = !!env.SHORTS_TEMP;

  const result = {
    ok: false,
    checks: {
      githubActionsTokenPresent: token.length > 0,
      cloudflareWorkerSecretPresent: workerSecret.length > 0,
      temporaryKvBindingPresent: kvAvailable
    },
    github: {
      checked: false,
      authenticated: false,
      repositoryAccess: false,
      workflowAccess: false,
      httpStatus: null,
      message: "GitHub kontrolü yapılmadı."
    },
    note: "Secret değerleri veya token parçaları bu uç noktadan asla döndürülmez."
  };

  if (!token) {
    result.github.message = "GITHUB_ACTIONS_TOKEN, bu Pages Function ortamında tanımlı değil.";
    return json(result, 200);
  }

  result.github.checked = true;
  try {
    const response = await fetch(
      "https://api.github.com/repos/emirgasim/CONTENT-FACTORY/actions/workflows/shorts-background.yml",
      {
        method: "GET",
        headers: {
          "Authorization": "Bearer " + token,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "ContentFactory-Safe-Diagnostics"
        }
      }
    );
    result.github.httpStatus = response.status;
    result.github.authenticated = response.status !== 401;
    result.github.repositoryAccess = response.status === 200;
    result.github.workflowAccess = response.status === 200;
    result.github.message = response.status === 200
      ? "GitHub token doğrulandı; hedef workflow okunabiliyor."
      : response.status === 401
        ? "GitHub token geçersiz veya iptal edilmiş."
        : response.status === 403
          ? "GitHub erişimi engellendi. Token izinlerini ve repository erişimini kontrol et."
          : response.status === 404
            ? "Depo veya workflow bu token ile görünür değil."
            : "GitHub API beklenmeyen bir HTTP yanıtı verdi.";
  } catch (error) {
    result.github.message = "GitHub API bağlantı hatası: " + String(error?.message || error).slice(0, 180);
  }

  result.ok =
    result.checks.githubActionsTokenPresent &&
    result.checks.cloudflareWorkerSecretPresent &&
    result.checks.temporaryKvBindingPresent &&
    result.github.repositoryAccess &&
    result.github.workflowAccess;

  return json(result, 200);
}

// Jenkins pipeline for prism (CI only: install -> typecheck -> test).
// Deploy is handled by GitHub Actions (.github/workflows/ci.yml Deploy step)
// since v0.164.1 (#45 + #46). This Jenkinsfile no longer ships to production.
//
// Runs inside a node:22 Docker container so the box only needs Docker + the
// Docker Pipeline plugin (no host Node).
//
// SECURITY: this repo is PUBLIC and the agent is self-hosted. If you wire this up
// as a multibranch/GitHub job, do NOT let untrusted fork PRs build on the box
// (set the branch source to "Exclude branches that are also filed as PRs" and
// disable "Discover pull requests from forks", mirroring the fork guard in ci.yml).
//
// Required Jenkins credentials (Manage Jenkins -> Credentials):
//   - ghcr-skyphusion  (User/pass)  ghcr.io pull creds (skyphusion-strummer + PAT);
//                                   used for authenticated pulls to avoid rate limits

pipeline {
  agent {
    docker {
      // Custom image: node:22 + Docker CLI + buildx, built/pushed on mindcrime-ci
      // (see ci/node-docker.Dockerfile). Docker CLI is available if a deploy step
      // needs host-daemon image builds; wrangler deploy for this Worker is TS-only.
      image 'ghcr.io/skyphusion-labs/ci-node-docker:latest'
      registryUrl 'https://ghcr.io'
      registryCredentialsId 'ghcr-skyphusion'
      // Bind-mount the host Docker socket and join the docker group by GID (988
      // on the fleet hosts) so wrangler's container builds reach the host daemon.
      // Docker Pipeline tokenizes args directly -- no shell evaluation -- so the
      // GID must be hardcoded; --group-add by name fails if the container has no
      // docker group entry in /etc/group. Still runs as the Jenkins uid, NOT root.
      args '-v /var/run/docker.sock:/var/run/docker.sock --group-add 988'
    }
  }

  options {
    // Generous headroom for npm ci + typecheck + vitest + wrangler deploy.
    timeout(time: 60, unit: 'MINUTES')
    disableConcurrentBuilds()
    timestamps()                 // requires the Timestamper plugin (ships by default)
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  environment {
    // Keep npm's cache and HOME inside the workspace (writable, cleaned per build).
    HOME = "${env.WORKSPACE}"
    npm_config_cache = "${env.WORKSPACE}/.npm"
    CI = 'true'
  }

  stages {
    stage('Install') {
      steps {
        sh 'node --version && npm --version'
        sh 'npm ci'
      }
    }

    stage('Typecheck') {
      steps {
        sh 'npm run typecheck'
      }
    }

    stage('Test') {
      steps {
        sh 'npm test'
      }
    }
  }

  post {
    // mail needs only a TaskListener (no node/workspace), so it is safe at the
    // top level even if a stage agent failed to come up (unlike sh). Sends via
    // the global Mailer (SMTP 127.0.0.1:2525 -> skyphusion-email relay).
    failure {
      mail to: 'conrad@rockenhaus.net',
           subject: "FAILED: ${env.JOB_NAME} #${env.BUILD_NUMBER}",
           body: "Build failed: ${env.BUILD_URL}"
    }
  }
}

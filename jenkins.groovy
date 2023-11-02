job {
  name 'chat-tmi-js-client'
  using 'TEMPLATE-autobuild'
  scm {
    git {
      remote {
        github 'chat/tmi-js-client', 'ssh', 'git.xarth.tv'
        credentials 'git-aws-read-key'
      }
      clean true
    }
  }
  steps {
    shell 'rm -rf .manta/'
    shell 'manta -v -proxy'
    saveDeployArtifact 'chat/tmi-js-client', '.manta'
  }
}

job {
  name 'chat-tmi-js-client-deploy'
  using 'TEMPLATE-deploy'
  steps {
    shell 'courier deploy --repo chat/tmi-js-client --dir /opt/twitch/tmi_client'
  }
}

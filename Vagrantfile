Vagrant.configure("2") do |config|
  config.vm.box = "ubuntu/trusty64"
  config.vm.synced_folder ".", "/home/vagrant/tmijs"
  config.ssh.forward_agent = true
  config.vm.network :public_network
  config.vm.provider :virtualbox do |vm|
    vm.name = "tmijs"
    vm.cpus = 2
    vm.memory = 2048
  end

  config.vm.provision :shell, inline: <<-SHELL
sudo apt-get update

# install deps
sudo apt-get install -y git inotify-tools

# install nodejs
curl -sL https://deb.nodesource.com/setup_5.x | sudo -E bash -
sudo apt-get install -y nodejs

chown -R vagrant:vagrant /home/vagrant/tmijs

SHELL
  
end

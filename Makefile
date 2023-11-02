
all:: build

.PHONY:: all build clean lint release test

VERSION=3
TMIJS_FILENAME=tmi-v${VERSION}.js

DEPLOY_DIR=deploy
DIST_DIR=${DEPLOY_DIR}/dist
BUILD_DIR=${DIST_DIR}/build
JSHINT=./node_modules/jshint/bin/jshint
JSCS=./node_modules/jscs/bin/jscs
BROCCOLI=./node_modules/broccoli-cli/bin/broccoli
TIMEPIECE=./node_modules/broccoli-timepiece/index.js
WEB=../web

SRC_DIR=src

clean:
	@rm -rf ${DIST_DIR}
	@mkdir -p ${DIST_DIR}

setup:
	npm install

lint:
	${JSHINT} ${SRC_DIR}
	${JSCS} ${SRC_DIR}

build: clean setup lint
	TMI_VERSION=${VERSION} ${BROCCOLI} build ${BUILD_DIR}

watch: clean setup lint
	TMI_VERSION=${VERSION} ${TIMEPIECE} ${BUILD_DIR}

link:
	mkdir -p ${WEB}/public/tmilibs && ln -sf `pwd`/${BUILD_DIR}/* ${WEB}/public/tmilibs

test: setup
	@echo "Browse to http://localhost.twitch.tv:4000/?tmi_host=tmi-darklaunch-7db8c8.sfo01.justin.tv&tmi_port=6667&tmi_log_level=debug"
	BROCCOLI_ENV=test ${BROCCOLI} serve --host 0.0.0.0 --port 4000

release: clean setup lint
	BROCCOLI_ENV=production TMI_VERSION=${VERSION} ${BROCCOLI} build ${BUILD_DIR}

	@mkdir -p ${DIST_DIR}/assets/tmilibs
	@mkdir -p ${DIST_DIR}/config

	@old_versions=""; \
	for f in versions/*.js; do \
		old_versions="$$old_versions ${BUILD_DIR}/versions/$$(basename $$f)"; \
	done; \
	${DEPLOY_DIR}/version_assets ${DIST_DIR}/assets/tmilibs ${DIST_DIR}/config ${BUILD_DIR}/JSSocket.swf ${BUILD_DIR}/${TMIJS_FILENAME} $$old_versions

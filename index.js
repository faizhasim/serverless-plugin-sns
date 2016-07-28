'use strict';

module.exports = function(S) {

    const AWS      = require('aws-sdk'),
        SCli       = require(S.getServerlessPath('utils/cli')),
        BbPromise  = require('bluebird'); // Serverless uses Bluebird Promises and we recommend you do to because they provide more than your average Promise :)

    class ServerlessPluginSNS extends S.classes.Plugin {
        constructor(S) {
            super(S);
        }

        static getName() {
            return 'com.serverless.' + ServerlessPluginSNS.name;
        }

        registerHooks() {

            S.addHook(this._addSNSAfterDeploy.bind(this), {
                action: 'functionDeploy',
                event:  'post'
            });
            S.addHook(this._addSNSAfterDeploy.bind(this), {
                action: 'dashDeploy',
                event:  'post'
            });

            return BbPromise.resolve();
        }

        /**
         * adds alerts after the deployment of a function
         *
         * @param object evt
         *
         * @return promise
         */
        _addSNSAfterDeploy(evt) {
            let _this = this;

            return new BbPromise(function(resolve, reject) {
                for(var region in evt.data.deployed) {
                    _this._manageSNS(evt, region);
                }

                return resolve(evt);
            });
        }

        /**
         * Handles the Creation of an alert and the required topics
         *
         * @param object evt Event
         * @param string region
         *
         * @return promise
         */
        _manageSNS (evt, region) {
            let _this = this;

            _this.stage = evt.options.stage;
            _this._initAws(region)
            .then(function() {

                _this.functionSNSSettings = _this._getFunctionsSNSSettings(evt, region);

                // no sns.json found
                if (_this.functionSNSSettings.length == 0) {
                    return;
                }

                return _this._manageTopics(_this.functionSNSSettings)
            })
            .then(function(){
                let _this = this;
                _this._bindFunctions(_this.functionSNSSettings);
            }.bind(_this))
            .catch(function(e){
                SCli.log('error in manage topics', e)
            });
        }

        /**
         * Binds functions to topics
         */
        _bindFunctions (settings) {
            let _this = this;

            for (var i in settings) {
                var functionName = settings[i].deployed.Arn;
                var functionArn = settings[i].deployed.Arn;
                functionArn = functionArn.split(':');
                functionArn.pop();
                functionArn = functionArn.join(':');

                var sns = _this._getTopicNamesBySettings(settings[i]);

                for (var j in sns) {
                    var topicArn = _this._getTopicArnByFunctionArn(functionArn, sns[j]);

                    SCli.log('binding function ' + settings[i].deployed.functionName + ' to topic ' + sns[j]);
                    _this.sns.subscribeAsync({
                        'Protocol': 'lambda',
                        'TopicArn': topicArn,
                        'Endpoint': functionArn + ":" + _this.stage,
                    })
                    .then(function(result){
                        var topicName = sns[j];
                        topicName = topicName.replace(/:/g, '_');
                        var statementId = settings[i].deployed.functionName + '_' + topicName;
                        return new BbPromise(function(resolve, reject) {
                            _this.lambda.removePermission(
                                {
                                    FunctionName: functionName,
                                    StatementId: statementId
                                },
                                function() {
                                    _this.lambda.addPermission({
                                        FunctionName: functionName,
                                        StatementId: statementId,
                                        Action: 'lambda:InvokeFunction',
                                        Principal: 'sns.amazonaws.com',
                                        SourceArn: topicArn,
                                    }, function callback(err, data) {
                                        if (err) {
                                            reject(err);
                                        } else {
                                            resolve(data);
                                        }
                                    });
                                }
                            );
                        });
                    })
                    .then(function(result) {
                        SCli.log('done');
                    });
                }
            }
        }

        /**
         * returns the topic that needs to be created replaces keys
         *
         * @param object settings
         *
         * @return array
         */
        _getTopicNamesBySettings (settings) {
            var replacements = [];
            replacements['project'] = S.getProject().name;
            replacements['stage'] = this.stage;
            replacements['functionName'] = settings.deployed.functionName;

            var topics = [];

            if (Object.prototype.toString.call(settings.sns) === '[object Array]') {
                for (var i in settings.sns) {
                    topics[settings.sns[i].topic] = settings.sns[i].topic
                }
            } else {
                topics = [settings.sns.topic];
            }

            for (var i in replacements) {
                for (var j in topics) {
                    topics[j] = topics[j].replace('${' + i + '}', replacements[i]);
                }
            }

            return topics;
        }

        _getTopicArnByFunctionArn(functionArn, topicName){
            if (topicName.indexOf('arn:aws:sns') >= 0) {
                return topicName;
            }

            var start = functionArn.split(':function:');
            var topicArn = start[0] + ':' + topicName;

            topicArn = topicArn.replace(':lambda:', ':sns:');
            return topicArn;
        }

        /**
         * collects the topics and calls create topcs
         *
         * @param array settings
         *
         * @return BpPromise
         */
        _manageTopics(settings) {
            var _this = this;

            var topics = [];
            var topicslist = [];
            for (var i in settings) {
                topicslist = _this._getTopicNamesBySettings(settings[i]);

                for (var j in topicslist) {
                    topics[topicslist[j]] = topicslist[j]
                }
            }

            return _this._createTopics(topics);
        }

        /**
         * creates topics if not yet done
         *
         * @param array topics
         *
         * @return BpPromise
         */
        _createTopics (topics) {
            var _this = this;
            _this.topics = topics;

            return _this.sns.listTopicsAsync()
            .then(function(topicListResult){
                var _this = this;
                //create fast checkable topiclist['topic1'] = 'topic1'
                var topicList = [];
                if (topicListResult['Topics']) {
                    for (var i in topicListResult.Topics) {
                        var arnParts = topicListResult.Topics[i].TopicArn.split(':')
                        var topicName = arnParts[arnParts.length - 1];
                        topicList[topicName] = topicName;
                    }
                }

                var topicCreatePromises = [];

                for (var i in this.topics) {
                    if (i.indexOf('arn:aws:sns') >= 0) {
                        continue;
                    }

                    if (!topicList[i]) {
                        SCli.log('topic ' + i + ' does not exist. it will be created now');
                        topicCreatePromises.push(
                            _this.sns.createTopicAsync({
                                'Name': i
                            })
                            .then(function(){
                                SCli.log('topic created');
                            })
                            .catch(function(e){
                                SCli.log('error during creation of the topic !', e)
                            })
                        );
                    } else {
                        SCli.log('topic ' + i + ' exists.');
                    }
                }

                if (topicCreatePromises.length > 0) {
                    return BbPromise.all(topicCreatePromises);
                } else {
                    return BbPromise.resolve();
                }
            }.bind(this));
        }

        /**
         * initializes aws
         *
         * @param string region
         *
         * @return void
         */
        _initAws (region) {
            let _this = this,
                credentials = S.getProvider('aws').getCredentials(_this.stage, region);

            return BbPromise.resolve()
            .then(function() {
                // Will handle this if it's a promise or an object
                return credentials;
            })
            .then(function(creds) {
                _this.sns = new AWS.SNS({
                    region: region,
                    accessKeyId: creds.accessKeyId,
                    secretAccessKey: creds.secretAccessKey,
                    sessionToken: creds.sessionToken
                });

                BbPromise.promisifyAll(_this.sns);

                _this.lambda = new AWS.Lambda({
                    region: region,
                    accessKeyId: creds.accessKeyId,
                    secretAccessKey: creds.secretAccessKey,
                    sessionToken: creds.sessionToken
                });
            })
        }


        /**
         * parses the sns-function.json file and returns the data
         *
         * @param object evt
         * @param string region
         *
         * @return array
         */
        _getFunctionsSNSSettings(evt, region){
            let _this = this;
            var settings = [];
            for (var deployedIndex in evt.data.deployed[region]) {
                let deployed = evt.data.deployed[region][deployedIndex],
                    functionName = deployed['functionName'],
                    config = S.getProject()['functions'][functionName];

                    if (!config.sns) {
                        continue;
                    }

                    settings.push({
                        "deployed": deployed,
                        "sns": config.sns
                    });
            }

            return settings;
        }
    }

    return ServerlessPluginSNS;
};

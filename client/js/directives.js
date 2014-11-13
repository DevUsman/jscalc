'use strict';

/* Directives */

angular.module('jscalcDirectives', [])
  .directive('jscalcCalc', [
    '$mdToast',
    'DEFAULTS',
    '$location',
    '$timeout',
    'jscalcDateInput',
    '$filter',
    function($mdToast, DEFAULTS, $location, $timeout, jscalcDateInput,
        $filter) {
      return {
        restrict: 'E',
        templateUrl: '/partials/calc',
        scope: {
          doc: '=',
          inputs: '=',
          editMode: '=',
          addInput: '&?',
          addOutput: '&?',
          configureInput: '&?',
          deleteInput: '&?',
          configureOutput: '&?',
          deleteOutput: '&?',
          gotoLine: '&?'
        },
        link: function($scope, element, attr) {
          $scope.DEFAULTS = DEFAULTS;
          var blobUrl;
          var worker = null;
          $scope.workerBuzy = false;
          $scope.workerError = null;
          $scope.debugMode = false;
          var recalculationScheduled = false;
          var calculationTimeoutPromise = null;

          angular.copy($scope.doc.defaults || {}, $scope.inputs);

          if (!('metaInputs' in $scope.doc)) {
            $scope.doc.metaInputs = [];
          }

          if (!('metaOutputs' in $scope.doc)) {
            $scope.doc.metaOutputs = [];
          }

          var convertInputs = function(inputs, metaInputs) {
            var convertedInputs = {};
            _.forEach(metaInputs, function(metaInput) {
              if (metaInput.name in convertedInputs) {
                throw {name: 'JscalcNameConflictError',
                    message: metaInput.name};
              }
              if (metaInput.type == 'list') {
                convertedInputs[metaInput.name] = _.map(inputs[metaInput.id],
                    function(item) {
                      return convertInputs(item, metaInput.metaInputs);
                    });
              } else if (metaInput.type == 'date') {
                var dateMoment = jscalcDateInput.toDate(inputs[metaInput.id],
                    DEFAULTS.dateInputValueType);
                convertedInputs[metaInput.name] = dateMoment ?
                    dateMoment.toDate() : null;
              } else {
                convertedInputs[metaInput.name] = inputs[metaInput.id];
              }
            });
            return convertedInputs;
          };

          var convertUsedInputs = function(usedInputs, metaInputs) {
            var convertedUsedInputs = {};
            _.forEach(metaInputs, function(metaInput) {
              if (!(metaInput.name in usedInputs)) return;
              convertedUsedInputs[metaInput.id] =
                  {used: usedInputs[metaInput.name].used};
              if (metaInput.type == 'list') {
                convertedUsedInputs[metaInput.id].properties =
                    _.mapValues(usedInputs[metaInput.name].properties,
                        function(item) {
                          return {
                            used: item.used,
                            properties: convertUsedInputs(item.properties,
                                metaInput.metaInputs)
                          };
                        });
              }
            });
            return convertedUsedInputs;
          };

          var convertOutputs = function(outputs, metaOutputs) {
            var convertedOutputs = {};
            if (!angular.isObject(outputs)) {
              throw {name: 'JscalcExpectedObjectError'};
            }
            var keys = {};
            _.forEach(metaOutputs, function(metaOutput) {
              if (metaOutput.name in keys) {
                throw {name: 'JscalcNameConflictError',
                    message: metaOutput.name};
              }
              keys[metaOutput.name] = true;
            });
            for (var key in outputs) {
              if (!(key in keys)) {
                throw {name: 'JscalcUnrecognizedOutputError',
                    message: key};
              }
            }
            _.forEach(metaOutputs, function(metaOutput) {
              var output = outputs[metaOutput.name];
              var convertedOutput;
              if (metaOutput.type == 'table') {
                if (output == null || !angular.isDefined(output)) return;
                if (!angular.isArray(output)) {
                  throw {name: 'JscalcExpectedArrayError', message: metaOutput.name};
                }
                if (!output.length) return;
                convertedOutput = _.map(output,
                    function(item) {
                      return convertOutputs(item, metaOutput.metaOutputs);
                    });
              } else if (metaOutput.type == 'value') {
                if (angular.isString(output)) {
                  convertedOutput = {type: 'string', value: output};
                } else if (_.isBoolean(output)) {
                  convertedOutput = {type: 'boolean', value: output};
                } else if (angular.isNumber(output)) {
                  var percentSign = '';
                  if (metaOutput.percent) {
                    output = output / 100;
                    percentSign = '%';
                  }
                  var currencySign = metaOutput.percent ? '' :
                      (metaOutput.currencySign || '');
                  convertedOutput = {type: 'number', value: currencySign +
                    $filter('number')(output, angular.isNumber(metaOutput.decimalPlaces) ? metaOutput.decimalPlaces : undefined) +
                    percentSign};
                } else if (angular.isDate(output)) {
                  convertedOutput = {type: 'date',
                      value: $filter('date')(output, 'mediumDate')};
                } else if (output == null || !angular.isDefined(output)) {
                  return;
                } else {
                  throw {name: 'JscalcValueTypeError', message: metaOutput.name};
                }
              }
              convertedOutputs[metaOutput.id] = convertedOutput;
            });
            return convertedOutputs;
          };

          var refreshWorker = function() {
            if (blobUrl) window.URL.revokeObjectURL(blobUrl);
            var hostUrl = $location.protocol() + '://' + $location.host();
            if ($location.port()) hostUrl += ':' + $location.port();
            var imports = [hostUrl + '/js/worker.js'];
            if ($scope.doc.libraries.lodash) imports.push(hostUrl + '/bower_components/lodash/dist/lodash.min.js');
            if ($scope.doc.libraries.moment) imports.push(hostUrl + '/bower_components/moment/min/moment.min.js');
            if ($scope.doc.libraries.mathjs) imports.push(hostUrl + '/bower_components/mathjs/dist/math.min.js');
            var importsStr = 'importScripts(' + _.map(imports, function(importStr) {
              return '"' + importStr + '"';
            }).join(', ') + ');\n';
            blobUrl = window.URL.createObjectURL(new Blob([
              'var calculate = function(inputs) {' + $scope.doc.script + '};\n\n' + importsStr
            ]));
            if (worker) destroyWorker();
            requestRecalculation();
          };

          $scope.$watch('doc.script', refreshWorker);
          $scope.$watch('doc.libraries', refreshWorker, true);

          $scope.$watch('doc.metaOutputs', function() {
            requestRecalculation();
          }, true);

          var cancelCalculationTimeout = function() {
            if (calculationTimeoutPromise) {
              $timeout.cancel(calculationTimeoutPromise);
              calculationTimeoutPromise = null;
            }
          };

          var createWorker = function() {
            worker = new Worker(blobUrl);
            worker.onmessage = function(e) {
              $scope.$apply(function() {
                cancelCalculationTimeout();
                $scope.workerBuzy = false;
                if ('outputs' in e.data) {
                  try {
                    $scope.outputs = convertOutputs(e.data.outputs,
                        $scope.doc.metaOutputs);
                    $scope.workerError = null;
                  } catch(e) {
                    if (e.name == 'JscalcExpectedObjectError') {
                      $scope.workerError = {message: 'Outputs and table rows must be objects.'};
                    } else if (e.name == 'JscalcNameConflictError') {
                      $scope.workerError = {message: 'Multiple outputs have name "' + e.message + '".'};
                    } else if (e.name == 'JscalcUnrecognizedOutputError') {
                      $scope.workerError = {message: 'The outputs object or a table row object has unrecognized key "' + e.message + '".'};
                    } else if (e.name == 'JscalcExpectedArrayError') {
                      $scope.workerError = {message: 'Output "' + e.message + '" must be an array, null, or undefined.'};
                    } else if (e.name == 'JscalcValueTypeError') {
                      $scope.workerError = {message: 'Invalid value for "' + e.message + '". Values must be numbers, strings, booleans, nulls, or undefined.'};
                    } else {
                      throw e;
                    }
                    $scope.outputs = null;
                  }
                }
                $scope.usedInputs = convertUsedInputs(e.data.usedInputs,
                    $scope.doc.metaInputs);
              });
            };
            worker.onerror = function(e) {
              $scope.$apply(function() {
                e.preventDefault();
                cancelCalculationTimeout();
                var isChrome = /Chrome/.test(navigator.userAgent) && /Google Inc/.test(navigator.vendor);
                var isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
                var errorPrefix = '';
                if (isChrome) errorPrefix = 'Uncaught ';
                if (isFirefox) errorPrefix = 'InternalError: uncaught exception: ';
                var message = e.message;
                if (errorPrefix && message.indexOf(errorPrefix) == 0) {
                  message = message.slice(errorPrefix.length);
                }
                $scope.workerError = {message: message};
                if (e.lineno) {
                  $scope.workerError.lineNumber = e.lineno;
                }
                $scope.outputs = null;
              });
            }
          };

          var destroyWorker = function() {
            worker.terminate();
            worker = null;
            $scope.workerBuzy = false;
            $scope.workerError = null;
            cancelCalculationTimeout();
          };

          var startWorker = function() {
            if (!worker) {
              createWorker();
            }
            if ($scope.workerBuzy) {
              destroyWorker();
              createWorker();
            }
            try {
              var convertedInputs = convertInputs($scope.inputs,
                  $scope.doc.metaInputs);
            } catch(e) {
              if (e.name != 'JscalcNameConflictError') {
                throw e;
              }
              $scope.workerError = {message: 'Multiple inputs have name "' + e.message + '".'};
              return;
            }
            calculationTimeoutPromise = $timeout(function() {
              $scope.workerError = {message: 'Calculation did not finish after 5 seconds. Is there an infinite loop?'};
              $scope.outputs = null;
            }, 5000);
            $scope.workerBuzy = true;
            worker.postMessage({
              inputs: convertedInputs
            });
          };

          var requestRecalculation = function() {
            if ($scope.debugMode) return;
            if (!recalculationScheduled) {
              recalculationScheduled = true;
              $timeout(function() {
                recalculationScheduled = false;
                startWorker();
              });
            }
          };

          $scope.$watch(function() {
            try {
              return convertInputs($scope.inputs,
                  $scope.doc.metaInputs);
            } catch (e) {
              if (e.name != 'JscalcNameConflictError') {
                throw e;
              }
              return null;
            }
          }, requestRecalculation, true);

          $scope.toggleDebugMode = function() {
            $scope.debugMode = !$scope.debugMode;
            if (!$scope.debugMode) requestRecalculation();
          };

          $scope.calculate = startWorker;

          $scope.getInputTemplateName = function(metaInput) {
            var getType = function() {
              if (metaInput.type == 'binary') {
                return metaInput.presentationType;
              } else if (metaInput.type == 'choice') {
                return metaInput.presentationType;
              } else {
                return metaInput.type;
              }
            };
            return '/partials/input_' + getType();
          };

          $scope.getOutputTemplateName = function(metaOutput) {
            return '/partials/output_' + metaOutput.type;
          };

          $scope.updateDefaults = function() {
            if (!$scope.doc.defaults) {
              $scope.doc.defaults = {};
            }
            angular.copy($scope.inputs, $scope.doc.defaults);
            $mdToast.show({
              template: '<md-toast>Defaults set to current values.</md-toast>',
              hideDelay: 3000
            });
          };

          $scope.loadDefaults = function() {
            angular.copy($scope.doc.defaults, $scope.inputs);
          };

          $scope.showDefaultsButtons = function() {
            return !angular.equals($scope.doc.defaults || {}, $scope.inputs);
          };

          $scope.addItem = function(items, metaInput) {
            items.push(angular.copy(metaInput.itemPrototype));
          };

          $scope.deleteItem = function(items, index) {
            items.splice(index, 1);
          };
        }
      };
    }])
  .directive('jscalcDefault', function() {
    return {
      restrict: 'A',
      require: 'ngModel',
      scope: {
        defaultValue: '='
      },
      link: function($scope, element, attr, ngModel) {
        function toUser(value) {
          if (!angular.isDefined(value) || value === null) {
            return $scope.defaultValue;
          }
          return value;
        }
        ngModel.$formatters.push(toUser);
      }
    };
  })
  .directive('jscalcNumberToString', function() {
    return {
      restrict: 'A',
      require: 'ngModel',
      link: function($scope, element, attr, ngModel) {
        function toUser(value) {
          return value.toString();
        }
        function fromUser(value) {
          return Number(value);
        }
        ngModel.$formatters.push(toUser);
        ngModel.$parsers.push(fromUser);
      }
    };
  })
  .directive('jscalcDateInput', ['jscalcDateInput', function(jscalcDateInput) {
    return {
      restrict: 'E',
      templateUrl: '/partials/jscalc_date_input',
      scope: {
        value: '=ngModel',
        defaultValueType: '@?'
      },
      compile: function(element, attr) {
        return {
          pre: function($scope, element, attr) {
            $scope.months = [
              {value: 0, label: 'Jan'},
              {value: 1, label: 'Feb'},
              {value: 2, label: 'Mar'},
              {value: 3, label: 'Apr'},
              {value: 4, label: 'May'},
              {value: 5, label: 'Jun'},
              {value: 6, label: 'Jul'},
              {value: 7, label: 'Aug'},
              {value: 8, label: 'Sep'},
              {value: 9, label: 'Oct'},
              {value: 10, label: 'Nov'},
              {value: 11, label: 'Dec'}
            ];

            $scope.units = [
              {value: 'days', label: 'Days'},
              {value: 'months', label: 'Months'},
              {value: 'years', label: 'Years'}
            ];

            $scope.getAbsoluteDate = function() {
              return jscalcDateInput.getAbsoluteDate($scope.value && $scope.value.params).toDate();
            };

            $scope.getType = function() {
              return ($scope.value && $scope.value.type) ||
                  $scope.defaultValueType;
            }

            $scope.toggleType = function() {
              var date = jscalcDateInput.toDate($scope.value,
                  $scope.defaultValueType);
              $scope.value.type = {'absolute': 'relative', 'relative': 'absolute'}[$scope.getType()];
              if (date) {
                if ($scope.getType() == 'absolute') {
                  $scope.value.params = {
                    day: date.date(),
                    month: date.month(),
                    year: date.year()
                  };
                } else {
                  $scope.value.params = {
                    delta: date.diff(moment().startOf('day'), 'days'),
                    units: 'days'
                  };
                }
              } else {
                $scope.value.params = {};
              }
            };
          }
        }
      }
    };
  }]);

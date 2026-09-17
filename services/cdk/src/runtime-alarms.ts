import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";

/**
 * The topic every runtime alarm publishes to.
 *
 * Created unconditionally, even with zero subscribers. Until this existed, all 13 alarms in
 * runtime-observability.ts were constructed with no action at all: they changed state and
 * notified nobody, which is operationally indistinguishable from having no alarms. A topic
 * with no subscribers is still strictly better, because "every alarm has an action" becomes a
 * property of the synthesized template — asserted over *every* alarm in
 * runtime-alarm-routing.test.ts rather than over a list of 13 that a fourteenth alarm could
 * silently escape — and subscribing then costs one `aws sns subscribe`, not a code change and
 * a redeploy.
 *
 * Deliberately not KMS-encrypted. An alarm notification carries metric metadata only: alarm
 * name, namespace, metric, threshold, state transition and timestamp, with no session,
 * repository, or credential content. CloudWatch cannot publish through the AWS-managed
 * `alias/aws/sns` key because that key's policy cannot be edited, so encrypting here would
 * require a customer-managed key, and every `pnpm purge` would drop one into a 7-30 day
 * deletion window — a real recurring cost in a repo that tears environments down routinely.
 * `enforceSSL` still denies any publish attempted over plaintext HTTP. Revisit this if the
 * topic ever carries a payload rather than a state transition.
 */
export function createAlarmTopic(
  scope: Construct,
  environment: string,
  emails: readonly string[],
): sns.Topic {
  const topic = new sns.Topic(scope, "AlarmTopic", {
    displayName: `${environment} alarms`,
    enforceSSL: true,
  });
  for (const email of emails) {
    topic.addSubscription(new subscriptions.EmailSubscription(email));
  }
  return topic;
}

/**
 * The only way this package builds a CloudWatch alarm.
 *
 * `topic` is a required parameter rather than an optional one, and routing happens here rather
 * than at the call sites, so that adding a fourteenth alarm cannot reintroduce an unrouted one.
 * That is the exact defect this module exists to fix, and a guard that a new call site can
 * forget is not a guard.
 *
 * Alarm action only, no OK action. Every caller pairs `treatMissingData: NOT_BREACHING` with a
 * single datapoint over one period, so a sparse `Sum` metric returns to OK on the very next
 * period. OK actions would therefore roughly double the notification volume to report that a
 * one-off spike had stopped, which is not what an operator is paged for; recovery stays visible
 * in the alarm's own history.
 */
export function addErrorAlarm(
  scope: Construct,
  id: string,
  metric: cloudwatch.IMetric,
  threshold: number,
  topic: sns.ITopic,
): cloudwatch.Alarm {
  const alarm = new cloudwatch.Alarm(scope, id, {
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric,
    threshold,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  alarm.addAlarmAction(new cloudwatchActions.SnsAction(topic));
  return alarm;
}

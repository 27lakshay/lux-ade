//! `activity.*`, `notification.delivery.*` and `notification.preferences.*`
//! operations, and the
//! `activity_changed` feed frames that follow committed activity.
use super::*;
use ade_core::contract::activity::{
    Activity, ActivityChanged, ActivityListRequest, ActivityMarkRequest, ActivityMarked,
    NotificationDeliveries, NotificationDeliveryClaim, NotificationDeliveryClaimRequest,
    NotificationDeliveryListRequest, NotificationDeliveryReply, NotificationDeliveryReportRequest,
    NotificationPreferencesGetRequest, NotificationPreferencesSetRequest,
};

/// Frames published per database read while catching the feed up.
const FRAME_BATCH: u32 = 100;

impl Sessions {
    pub(super) fn activity_command(&self, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "activity.list" => {
                let list: ActivityListRequest = decode(request)?;
                reply(&self.data.lock().unwrap().store.activity_list(&list)?)
            }
            "activity.mark" => {
                let mark: ActivityMarkRequest = decode(request)?;
                let mut d = self.data.lock().unwrap();
                let marked =
                    persistence_result(d.store.activity_mark(&mark.activity_ids, mark.mark))?;
                let mut activities = Vec::with_capacity(marked.len());
                for (activity, changed) in marked {
                    if changed {
                        self.publish_activity(&mut d, &activity);
                    }
                    activities.push(activity);
                }
                reply(&ActivityMarked {
                    tag: Default::default(),
                    activities,
                })
            }
            "notification.delivery.claim" => {
                let claim: NotificationDeliveryClaimRequest = decode(request)?;
                let (granted, delivery) =
                    persistence_result(self.data.lock().unwrap().store.claim_delivery(&claim))?;
                reply(&NotificationDeliveryClaim {
                    tag: Default::default(),
                    granted,
                    delivery,
                })
            }
            "notification.delivery.report" => {
                let report: NotificationDeliveryReportRequest = decode(request)?;
                let delivery =
                    persistence_result(self.data.lock().unwrap().store.report_delivery(&report))?;
                reply(&NotificationDeliveryReply {
                    tag: Default::default(),
                    delivery,
                })
            }
            "notification.delivery.list" => {
                let list: NotificationDeliveryListRequest = decode(request)?;
                reply(&NotificationDeliveries {
                    tag: Default::default(),
                    deliveries: self
                        .data
                        .lock()
                        .unwrap()
                        .store
                        .deliveries(list.status, list.limit)?,
                })
            }
            "notification.preferences.get" => {
                let _: NotificationPreferencesGetRequest = decode(request)?;
                reply(&self.data.lock().unwrap().store.notification_preferences()?)
            }
            "notification.preferences.set" => {
                let set: NotificationPreferencesSetRequest = decode(request)?;
                reply(&persistence_result(
                    self.data
                        .lock()
                        .unwrap()
                        .store
                        .set_notification_preferences(set.desktop, &set.muted_kinds),
                )?)
            }
            _ => bail!("Unknown session operation"),
        }
    }

    fn publish_activity(&self, d: &mut Data, activity: &Activity) {
        let frame = json!(ActivityChanged {
            tag: Default::default(),
            activity: activity.clone(),
            boot_id: self.boot_id.clone(),
            revision: d.revision,
        });
        self.publish(d, frame);
    }

    /// Starts frames after the activity already recorded, which clients read
    /// with `activity.list`.
    pub(super) fn start_activity_feed(&self) -> Result<()> {
        let mut d = self.data.lock().unwrap();
        d.activity_published = Some(d.store.latest_activity_sequence()?);
        Ok(())
    }

    /// Publishes an `activity_changed` frame for each activity committed since
    /// the last one published. The database is the source, so an activity
    /// committed on any path reaches the feed on the next flush.
    pub(super) fn flush_activity(&self, d: &mut Data) -> Result<()> {
        let Some(mut published) = d.activity_published else {
            return Ok(());
        };
        loop {
            let batch = d.store.activity_since(published, FRAME_BATCH)?;
            let Some(last) = batch.last().map(|a| a.sequence) else {
                return Ok(());
            };
            for activity in &batch {
                self.publish_activity(d, activity);
            }
            published = last;
            d.activity_published = Some(published);
            if batch.len() < FRAME_BATCH as usize {
                return Ok(());
            }
        }
    }
}

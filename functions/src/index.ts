import {logger} from "firebase-functions";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";

initializeApp();

/**
 * Error that is thrown when a lap is created
 * less than 2 minutes after the last lap.
 */
class LapTooEarlyError extends Error {
  /**
   * @param {sting} msg - The error message (never used)
   */
  constructor(msg: string) {
    super(msg);
    Object.setPrototypeOf(this, LapTooEarlyError.prototype);
  }
}

export const createLap = onCall(
  {
    region: "europe-west1",
    minInstances: 0, // FIXME: Set to 0 after release
    maxInstances: 10,
  },
  async (request) => {
    // Check if the user is authenticated
    if (!request.auth || request.auth.token.role !== "assistant") {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    // Ensure the request contains the 'number' field
    const number = request.data.number as number;
    if (!number) {
      throw new HttpsError("invalid-argument", "Missing field: number");
    }

    const now = new Date();

    const firestore = getFirestore();

    // Check if there is a runner with the specified number
    const runnerQuery = await firestore
      .collection("runners")
      .where("number", "==", number)
      .limit(1)
      .get();

    if (runnerQuery.empty) {
      throw new HttpsError("not-found", "Läufer nicht gefunden.");
    }

    const runner = {
      id: runnerQuery.docs[0].id,
      name: runnerQuery.docs[0].data().name,
      number: runnerQuery.docs[0].data().number,
      type: runnerQuery.docs[0].data().type,
    };

    const runnerRef = firestore.doc(`runners/${runner.id}`);

    try {
      const newLap = await firestore.runTransaction(async (transaction) => {
        const runnerDoc = await transaction.get(runnerRef);

        const lastLapCreatedAt = runnerDoc.data()?.lastLapCreatedAt;

        // Check if the last lap was less than 2 minutes ago
        if (lastLapCreatedAt) {
          const lastLapDate = lastLapCreatedAt.toDate();

          if (now.getTime() - lastLapDate.getTime() < 2 * 60 * 1000) {
            throw new LapTooEarlyError("Last lap less than 2 minutes ago.");
          }
        }

        // Create a new lap
        const newLap = {
          runnerId: runner.id,
          createdAt: now,
          runnerData: {
            name: runner.name,
            number: runner.number,
          },
        };

        // Add the new lap
        const newLapRef = firestore.collection("laps").doc();
        transaction.set(newLapRef, newLap);

        // Update the runner
        await transaction.update(runnerRef, {
          lastLapCreatedAt: now,
          laps: (runnerDoc.data()?.laps || 0) + 1,
        });

        // Return the new lap
        return {
          id: newLapRef.id,
          runnerId: newLap.runnerId,
          createdAt: newLap.createdAt.getTime(),
        };
      });

      return {
        id: newLap.id,
        runnerId: newLap.runnerId,
        createdAt: newLap.createdAt,
        runner,
      };
    } catch (err) {
      if (err instanceof LapTooEarlyError) {
        throw new HttpsError(
          "failed-precondition",
          "Letzte Runde weniger als 2 Minuten her."
        );
      } else {
        logger.error(err);
        throw new HttpsError("internal", "Internal server error");
      }
    }
  }
);

export const deleteLap = onCall(
  {
    region: "europe-west1",
    minInstances: 0, // FIXME: Set to 0 after release
    maxInstances: 10,
  },
  async (request) => {
    // Check if the user is authenticated
    // Check if the user is authenticated
    if (!request.auth || request.auth.token.role !== "assistant") {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    // Ensure the request contains the 'lapId' field
    const lapId = request.data.lapId as string;
    if (!lapId) {
      throw new HttpsError("invalid-argument", "Missing field: lapId");
    }

    const firestore = getFirestore();

    const lapRef = firestore.doc(`laps/${lapId}`);

    try {
      await firestore.runTransaction(async (transaction) => {
        const lapDoc = await transaction.get(lapRef);

        if (!lapDoc.exists) {
          throw new HttpsError("not-found", "Runde nicht gefunden.");
        }

        const runnerId = lapDoc.data()?.runnerId;

        if (!runnerId) {
          await transaction.delete(lapRef);
          return;
        }

        const runnerRef = firestore.doc(`runners/${runnerId}`);
        const runnerDoc = await transaction.get(runnerRef);

        if (!runnerDoc.exists) {
          throw new HttpsError("not-found", "Läufer nicht gefunden.");
        }

        await transaction.delete(lapRef);
        await transaction.update(runnerRef, {
          lastLapCreatedAt: null,
          laps:
            (runnerDoc.data()?.laps || 0) - 1 >= 0 ?
              (runnerDoc.data()?.laps || 0) - 1 :
              0,
        });
      });
    } catch (err) {
      logger.error(err);
      throw new HttpsError("internal", "Internal server error");
    }
  }
);

export const createRunner = onCall(
  {
    region: "europe-west1",
    maxInstances: 1,
  },
  async (request) => {
    // Check if the user is authenticated
    if (!request.auth || request.auth.token.role !== "assistant") {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    // Ensure the request contains the 'name' field
    const name = request.data.name as string;
    if (!name) {
      throw new HttpsError("invalid-argument", "Missing field: name");
    }

    const email = request.data.email as string | undefined;

    const firestore = getFirestore();

    const newestRunnerRef = firestore
      .collection("runners")
      .orderBy("number", "desc")
      .limit(1);

    try {
      const newRunner = await firestore.runTransaction(async (transaction) => {
        const newestRunnerDoc = await transaction.get(newestRunnerRef);

        const newNumber = newestRunnerDoc.empty ?
          1 :
          newestRunnerDoc.docs[0].data().number + 1;

        let newRunner: {
          name: string;
          number: number;
          type: string;
          laps: number;
          email?: string;
        } = {
          name,
          number: newNumber,
          type: "guest",
          laps: 0,
        };

        if (email) {
          newRunner = {...newRunner, email};
        }

        const newRunnerRef = firestore.collection("runners").doc();
        transaction.set(newRunnerRef, newRunner);

        return newRunner;
      });

      return newRunner;
    } catch (err) {
      logger.error(err);
      throw new HttpsError("internal", "Internal server error");
    }
  }
);

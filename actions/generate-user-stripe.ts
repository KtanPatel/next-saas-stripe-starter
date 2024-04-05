"use server";

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Session } from "next-auth";



import { stripe } from "@/lib/stripe";
import { getUserSubscriptionPlan } from "@/lib/subscription";
import { absoluteUrl } from "@/lib/utils";





export type responseAction = {
  status: "success" | "error";
  stripeUrl?: string;
};

// const billingUrl = absoluteUrl("/dashboard/billing")
const billingUrl = absoluteUrl("/pricing");

async function createCheckoutSession(
  priceId: string,
  session: Session,
  customerId?: string,
): Promise<string> {
  const stripeSession = await stripe.checkout.sessions.create({
    success_url: billingUrl,
    cancel_url: billingUrl,
    payment_method_types: ["card"],
    mode: "subscription",
    billing_address_collection: "auto",
    ...(customerId
      ? { customer: customerId }
      : { customer_email: session.user.email! }),
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    metadata: {
      userId: session.user.id,
    },
  });

  return stripeSession.url as string;
}

export async function generateUserStripe(
  priceId: string,
): Promise<responseAction> {
  let redirectUrl: string = "";

  try {
    const session = await auth();

    if (!session?.user || !session?.user.email) {
      throw new Error("Unauthorized");
    }

    const subscriptionPlan = await getUserSubscriptionPlan(session.user.id);

    if (subscriptionPlan.isPaid && subscriptionPlan.stripeCustomerId) {
      // User has requested to open portal session
      if (subscriptionPlan.stripePriceId === priceId) {
        // User on Paid Plan - Create a portal session to manage subscription.
        const stripeSession = await stripe.billingPortal.sessions.create({
          customer: subscriptionPlan.stripeCustomerId,
          return_url: billingUrl,
        });

        redirectUrl = stripeSession.url as string;
      } else {
        // User want to switch plan - cancel existing and create new checkout session
        const subscription = await stripe.subscriptions.retrieve(
          subscriptionPlan.stripeSubscriptionId!,
        );
        const deletedSubscription = await stripe.subscriptions.cancel(
          subscriptionPlan.stripeSubscriptionId!,
          {
            prorate: true,
            cancellation_details: {
              comment:
                "subscription upgraded or downgraded, So existing subscription is cancelled.",
            },
          },
        );

        redirectUrl = await createCheckoutSession(
          priceId,
          session,
          subscription.customer.toString(),
        );
      }
    } else {
      // User on Free Plan - Create a checkout session to upgrade.
      redirectUrl = await createCheckoutSession(priceId, session);
    }
  } catch (error) {
    console.log(error);

    throw new Error("Failed to generate user stripe session");
  }

  // no revalidatePath because redirect
  redirect(redirectUrl);
}
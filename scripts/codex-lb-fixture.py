"""Run real codex-lb routes/auth on a disposable database, without schedulers.

Only the outbound reset redemption is replaced. No OpenAI request or real
reset credit is used. Run through check-codex-lb.ts, which supplies isolation.
"""

import asyncio
import json
import os
import socket
from datetime import UTC, datetime
from pathlib import Path

data_dir = Path(os.environ["CODEX_LB_DATA_DIR"]).resolve()
assert (data_dir / ".isolated-hub-check").is_file(), "Disposable fixture directory required"
assert os.environ["CODEX_LB_DATABASE_URL"] == f"sqlite+aiosqlite:///{data_dir}/store.db"
assert os.environ["CODEX_LB_ENCRYPTION_KEY_FILE"] == str(data_dir / "encryption.key")

import uvicorn

from app.core.clients.rate_limit_reset_credits import RateLimitResetCreditsSnapshot, ResetCreditItem
from app.core.auth.dashboard_access import PRESET_ROLE_IDS, PresetRoleSlug
from app.db.models import Account, AccountStatus, Base, DashboardUser
from app.db.session import SessionLocal, engine
from app.main import create_app
from app.modules.auth_providers.seed import ensure_default_auth_providers
from app.modules.dashboard_roles.seed import ensure_preset_dashboard_roles
from app.modules.dashboard_auth.service import hash_password
from app.modules.rate_limit_reset_credits import api as reset_api
from app.modules.rate_limit_reset_credits.store import get_rate_limit_reset_credits_store


async def fake_redeem(*, account, store, redeem_request_id, **kwargs):
    assert redeem_request_id == "isolated-redeem", "Hub lost redemption deduplication id"
    snapshot = store.get(account.id)
    assert snapshot and snapshot.available_count > 0
    await store.mark_credit_redeemed(account.id, snapshot.credits[0].id, redeemed_at=datetime.now(UTC))
    return reset_api._RedeemResetCreditOutcome(
        response=reset_api.ConsumeResetCreditResponseSchema(code="reset", windows_reset=2),
        available_count_before=snapshot.available_count,
        available_count_after=snapshot.available_count - 1,
    )


class FixtureServer(uvicorn.Server):
    async def startup(self, sockets=None):
        await super().startup(sockets=sockets)
        print("HUB_FIXTURE_READY " + json.dumps({"port": sockets[0].getsockname()[1]}), flush=True)


async def main():
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await ensure_preset_dashboard_roles(connection)
        await ensure_default_auth_providers(connection)
    async with SessionLocal() as session:
        session.add(DashboardUser(
            username="admin", role_id=PRESET_ROLE_IDS[PresetRoleSlug.ADMIN],
            password_hash=hash_password("isolated-fixture-password"), is_break_glass=True,
        ))
        for account_id in ["account-a", "account-b"]:
            session.add(Account(
                id=account_id, chatgpt_account_id=f"chatgpt-{account_id}",
                email=f"{account_id}@example.test", plan_type="plus", status=AccountStatus.ACTIVE,
                access_token_encrypted=b"fixture", refresh_token_encrypted=b"fixture",
                id_token_encrypted=b"fixture", last_refresh=datetime.now(UTC),
            ))
        await session.commit()
    store = get_rate_limit_reset_credits_store()
    for account_id, count in [("account-a", 2), ("account-b", 3)]:
        credits = [ResetCreditItem(
            id=f"{account_id}-credit-{index}", reset_type="codex_rate_limits",
            status="available", expires_at=datetime(2030, 1, 1, tzinfo=UTC),
        ) for index in range(count)]
        await store.set(account_id, RateLimitResetCreditsSnapshot(
            available_count=count, nearest_expires_at=credits[0].expires_at, credits=credits,
        ))
    reset_api._redeem_soonest_reset_credit = fake_redeem
    # Production app and middleware; lifecycle disabled so no refresh scheduler,
    # migrations, telemetry or external provider calls run in this fixture.
    app = create_app()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        await FixtureServer(uvicorn.Config(app, lifespan="off", log_level="error")).serve(sockets=[listener])


asyncio.run(main())

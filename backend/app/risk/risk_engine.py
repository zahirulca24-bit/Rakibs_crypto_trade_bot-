from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RiskConfig:
    """Risk rules for an ENTRY signal.

    This engine is calculation-only. It does not place orders, change leverage,
    or communicate with an exchange.
    """

    risk_per_trade_pct: float = 1.0
    stop_atr_multiple: float = 1.5
    reward_r_multiple: float = 2.0
    max_leverage: float = 10.0
    max_position_equity_pct: float = 100.0


class RiskEngine:
    """Convert a validated 5m ENTRY signal into a risk-approved trade plan."""

    def __init__(self, config: RiskConfig | None = None) -> None:
        self.config = config or RiskConfig()
        self._validate_config()

    def _validate_config(self) -> None:
        cfg = self.config
        if not 0 < cfg.risk_per_trade_pct <= 5:
            raise ValueError("risk_per_trade_pct must be > 0 and <= 5")
        if cfg.stop_atr_multiple <= 0:
            raise ValueError("stop_atr_multiple must be > 0")
        if cfg.reward_r_multiple < 1:
            raise ValueError("reward_r_multiple must be >= 1")
        if not 1 <= cfg.max_leverage <= 100:
            raise ValueError("max_leverage must be between 1 and 100")
        if not 0 < cfg.max_position_equity_pct <= 100:
            raise ValueError("max_position_equity_pct must be > 0 and <= 100")

    def analyze(
        self,
        entry_row: dict[str, Any],
        *,
        account_equity: float,
        requested_leverage: float = 1.0,
    ) -> dict[str, Any]:
        """Return APPROVED/REJECTED risk plan for a 5m Entry Engine row.

        Required upstream fields:
        - status == ENTRY
        - side == LONG or SHORT
        - close_5m > 0
        - atr_pct_5m > 0
        """

        symbol = str(entry_row.get("symbol", "")).strip().upper()
        side = str(entry_row.get("side", "")).upper()
        status = str(entry_row.get("status", "")).upper()

        if not symbol:
            raise ValueError("symbol is required")
        if side not in {"LONG", "SHORT"}:
            raise ValueError("side must be LONG or SHORT")
        if status != "ENTRY":
            return self._rejected(symbol, side, "Risk Engine accepts ENTRY signals only")
        if account_equity <= 0:
            return self._rejected(symbol, side, "account equity must be greater than zero")

        entry_price = float(entry_row.get("close_5m") or 0.0)
        atr_pct = float(entry_row.get("atr_pct_5m") or 0.0)
        if entry_price <= 0:
            return self._rejected(symbol, side, "invalid entry price")
        if atr_pct <= 0:
            return self._rejected(symbol, side, "invalid ATR percentage")

        leverage = min(max(float(requested_leverage), 1.0), self.config.max_leverage)
        atr_value = entry_price * (atr_pct / 100.0)
        stop_distance = atr_value * self.config.stop_atr_multiple
        if stop_distance <= 0:
            return self._rejected(symbol, side, "invalid stop distance")

        risk_amount = account_equity * (self.config.risk_per_trade_pct / 100.0)
        raw_quantity = risk_amount / stop_distance

        max_margin = account_equity * (self.config.max_position_equity_pct / 100.0)
        max_notional = max_margin * leverage
        raw_notional = raw_quantity * entry_price
        approved_notional = min(raw_notional, max_notional)
        quantity = approved_notional / entry_price

        if quantity <= 0 or approved_notional <= 0:
            return self._rejected(symbol, side, "calculated position size is zero")

        actual_risk = quantity * stop_distance
        actual_risk_pct = (actual_risk / account_equity) * 100.0

        if side == "LONG":
            stop_loss = entry_price - stop_distance
            take_profit = entry_price + (stop_distance * self.config.reward_r_multiple)
        else:
            stop_loss = entry_price + stop_distance
            take_profit = entry_price - (stop_distance * self.config.reward_r_multiple)

        if stop_loss <= 0 or take_profit <= 0:
            return self._rejected(symbol, side, "calculated SL/TP is invalid")

        return {
            "engine": "Risk Engine",
            "version": "v1",
            "status": "APPROVED",
            "symbol": symbol,
            "side": side,
            "entry_price": round(entry_price, 8),
            "account_equity": round(account_equity, 8),
            "risk_per_trade_pct": round(self.config.risk_per_trade_pct, 4),
            "risk_amount": round(actual_risk, 8),
            "actual_risk_pct": round(actual_risk_pct, 4),
            "atr_pct_5m": round(atr_pct, 4),
            "stop_atr_multiple": round(self.config.stop_atr_multiple, 4),
            "stop_distance": round(stop_distance, 8),
            "stop_loss": round(stop_loss, 8),
            "reward_r_multiple": round(self.config.reward_r_multiple, 4),
            "take_profit": round(take_profit, 8),
            "quantity": round(quantity, 8),
            "notional": round(approved_notional, 8),
            "leverage": round(leverage, 4),
            "max_leverage": round(self.config.max_leverage, 4),
            "capped_by_notional": raw_notional > max_notional,
            "entry_score": entry_row.get("score"),
            "reason": "risk checks passed",
        }

    @staticmethod
    def _rejected(symbol: str, side: str, reason: str) -> dict[str, Any]:
        return {
            "engine": "Risk Engine",
            "version": "v1",
            "status": "REJECTED",
            "symbol": symbol,
            "side": side,
            "reason": reason,
        }

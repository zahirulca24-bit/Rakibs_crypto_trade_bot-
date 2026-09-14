from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, ROUND_DOWN
from typing import Any


@dataclass(frozen=True)
class PositionSizingConfig:
    """Exchange-safe sizing constraints.

    This engine only validates and rounds an APPROVED Risk Engine plan.
    It never places orders or communicates with an exchange.
    """

    min_quantity: float = 0.0
    quantity_step: float = 0.000001
    min_notional: float = 5.0
    max_notional_equity_pct: float = 100.0


class PositionSizingEngine:
    """Convert a Risk Engine plan into a final exchange-safe position size."""

    def __init__(self, config: PositionSizingConfig | None = None) -> None:
        self.config = config or PositionSizingConfig()
        self._validate_config()

    def _validate_config(self) -> None:
        cfg = self.config
        if cfg.min_quantity < 0:
            raise ValueError("min_quantity must be >= 0")
        if cfg.quantity_step <= 0:
            raise ValueError("quantity_step must be > 0")
        if cfg.min_notional < 0:
            raise ValueError("min_notional must be >= 0")
        if not 0 < cfg.max_notional_equity_pct <= 100:
            raise ValueError("max_notional_equity_pct must be > 0 and <= 100")

    def analyze(self, risk_plan: dict[str, Any]) -> dict[str, Any]:
        symbol = str(risk_plan.get("symbol", "")).strip().upper()
        side = str(risk_plan.get("side", "")).upper()
        status = str(risk_plan.get("status", "")).upper()

        if not symbol:
            raise ValueError("symbol is required")
        if side not in {"LONG", "SHORT"}:
            raise ValueError("side must be LONG or SHORT")
        if status != "APPROVED":
            return self._rejected(symbol, side, "Position Sizing accepts APPROVED risk plans only")

        entry_price = float(risk_plan.get("entry_price") or 0.0)
        account_equity = float(risk_plan.get("account_equity") or 0.0)
        requested_quantity = float(risk_plan.get("quantity") or 0.0)
        stop_distance = float(risk_plan.get("stop_distance") or 0.0)

        if entry_price <= 0:
            return self._rejected(symbol, side, "invalid entry price")
        if account_equity <= 0:
            return self._rejected(symbol, side, "invalid account equity")
        if requested_quantity <= 0:
            return self._rejected(symbol, side, "invalid requested quantity")
        if stop_distance <= 0:
            return self._rejected(symbol, side, "invalid stop distance")

        max_notional = account_equity * (self.config.max_notional_equity_pct / 100.0)
        max_quantity = max_notional / entry_price
        capped_quantity = min(requested_quantity, max_quantity)
        final_quantity = self._round_down_to_step(capped_quantity, self.config.quantity_step)

        if final_quantity <= 0:
            return self._rejected(symbol, side, "final quantity rounded to zero")
        if final_quantity < self.config.min_quantity:
            return self._rejected(symbol, side, "final quantity below minimum quantity")

        final_notional = final_quantity * entry_price
        if final_notional < self.config.min_notional:
            return self._rejected(symbol, side, "final notional below minimum notional")

        final_risk_amount = final_quantity * stop_distance
        final_risk_pct = (final_risk_amount / account_equity) * 100.0

        return {
            "engine": "Position Sizing Engine",
            "version": "v1",
            "status": "APPROVED",
            "symbol": symbol,
            "side": side,
            "entry_price": round(entry_price, 8),
            "requested_quantity": round(requested_quantity, 8),
            "final_quantity": round(final_quantity, 8),
            "quantity_step": self.config.quantity_step,
            "final_notional": round(final_notional, 8),
            "min_notional": round(self.config.min_notional, 8),
            "max_notional": round(max_notional, 8),
            "capped_by_exposure": requested_quantity > max_quantity,
            "final_risk_amount": round(final_risk_amount, 8),
            "final_risk_pct": round(final_risk_pct, 4),
            "stop_loss": risk_plan.get("stop_loss"),
            "take_profit": risk_plan.get("take_profit"),
            "leverage": risk_plan.get("leverage"),
            "reason": "position sizing checks passed",
        }

    @staticmethod
    def _round_down_to_step(quantity: float, step: float) -> float:
        quantity_decimal = Decimal(str(quantity))
        step_decimal = Decimal(str(step))
        units = (quantity_decimal / step_decimal).to_integral_value(rounding=ROUND_DOWN)
        return float(units * step_decimal)

    @staticmethod
    def _rejected(symbol: str, side: str, reason: str) -> dict[str, Any]:
        return {
            "engine": "Position Sizing Engine",
            "version": "v1",
            "status": "REJECTED",
            "symbol": symbol,
            "side": side,
            "reason": reason,
        }
